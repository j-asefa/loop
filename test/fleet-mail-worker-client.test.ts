import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { FleetMailWorkerClient } from "../src/server/fleet-mail-worker-client.js";
import { assertFleetMailTools } from "../src/server/fleet-mail-tools.js";
import { FleetMailWorkerRequest } from "../src/shared/fleet-mail-worker.js";
import type { MailDiscoveryPage } from "../src/shared/fleet-mail-discovery.js";

const machineId = "m_" + "b".repeat(64),
  sourceId = "peer:" + machineId;
const source = {
  machineId,
  sourceId,
  name: "Fixture",
  availability: "reachable" as const,
};
const caller = {
  runId: randomUUID(),
  agentId: randomUUID(),
  conversationId: randomUUID(),
  connectionId: randomUUID(),
  nativeGeneration: randomUUID(),
};
const query = { offset: 0, limit: 20 };
const clients: FleetMailWorkerClient[] = [];
function fixture() {
  const owner = randomUUID(),
    generation = randomUUID(),
    binding = randomUUID();
  const sent: FleetMailWorkerRequest[] = [];
  const client = new FleetMailWorkerClient(
    owner,
    generation,
    (request) => sent.push(request),
    100,
  );
  clients.push(client);
  const state = {
    requestId: randomUUID(),
    generation,
    binding,
    sources: [source],
  };
  client.configure(state);
  return { owner, generation, binding, sent, client, state };
}
const page = (): MailDiscoveryPage => ({
  source,
  agents: [],
  nextOffset: null,
});
const response = (request: FleetMailWorkerRequest) => ({
  requestId: request.requestId,
  generation: request.generation,
  binding: request.binding,
  ok: true,
  page: page(),
});
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});

it("keeps source discovery owner-bound and validates the private caller before IPC", () => {
  const { client, owner, sent } = fixture();
  assertFleetMailTools(owner);
  expect(() => assertFleetMailTools("another-owner")).toThrow("unavailable");
  expect(() =>
    client.read("peer:m_" + "c".repeat(64), query, () => {}, caller),
  ).toThrow("not authorized");
  expect(() => client.read(sourceId, query, () => {})).toThrow();
  expect(sent).toEqual([]);
});

it("checks the original caller before dispatch and after its correlated response", async () => {
  const { client, sent } = fixture();
  const current = vi.fn();
  const pending = client.read(sourceId, query, current, caller);
  expect(current).toHaveBeenCalledTimes(2);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ sourceId, caller, query });
  expect(
    FleetMailWorkerRequest.safeParse({ ...sent[0], owner: "another-owner" })
      .success,
  ).toBe(false);
  client.receive(response(sent[0]));
  expect(await pending).toEqual(page());
  expect(current).toHaveBeenCalledTimes(3);
});

it("drops a discovery result when the run or native generation changed during IPC", async () => {
  const { client, sent } = fixture();
  let live = true;
  const current = () => {
    if (!live) throw new Error("Original native generation retired");
  };
  const pending = client.read(sourceId, query, current, caller);
  live = false;
  client.receive(response(sent[0]));
  await expect(pending).rejects.toThrow("retired");
});

it("rejects outstanding reads on service replacement and never replays them", async () => {
  const { client, sent, state } = fixture();
  const pending = client.read(sourceId, query, () => {}, caller);
  const rejected = expect(pending).rejects.toThrow("unavailable");
  client.configure({ ...state, binding: randomUUID() });
  await rejected;
  client.receive(response(sent[0]));
  expect(sent).toHaveLength(1);
});

it("retains a matching read through catalog refresh but rejects another worker generation", async () => {
  const { client, sent, state } = fixture();
  const pending = client.read(sourceId, query, () => {}, caller);
  client.configure({
    ...state,
    sources: [{ ...source, name: "Renamed fixture" }],
  });
  expect(client.sources()[0].name).toBe("Renamed fixture");
  expect(() =>
    client.configure({ ...state, generation: randomUUID() }),
  ).toThrow("unavailable");
  client.receive(response(sent[0]));
  expect(await pending).toEqual(page());
});

it("does not accept another source's page for a matching request identity", async () => {
  const { client, sent } = fixture();
  const pending = client.read(sourceId, query, () => {}, caller);
  client.receive({
    ...response(sent[0]),
    page: { ...page(), source: { ...source, sourceId: "" } },
  });
  await expect(pending).rejects.toThrow("unavailable");
});

it("ignores late replies from another worker generation and times out without retransmission", async () => {
  vi.useFakeTimers();
  const { client, sent } = fixture();
  const pending = client.read(sourceId, query, () => {}, caller);
  const rejected = expect(pending).rejects.toThrow("unavailable");
  client.receive({ ...response(sent[0]), generation: randomUUID() });
  await vi.advanceTimersByTimeAsync(101);
  await rejected;
  client.receive(response(sent[0]));
  expect(sent).toHaveLength(1);
});

it("bounds pending requests and unregisters access when its execution session closes", async () => {
  const { client, owner, sent } = fixture();
  const pending = Array.from({ length: 16 }, () =>
    client.read(sourceId, query, () => {}, caller).catch((error) => error),
  );
  expect(() => client.read(sourceId, query, () => {}, caller)).toThrow("busy");
  expect(sent).toHaveLength(16);
  client.close();
  expect(
    (await Promise.all(pending)).every((error) => error instanceof Error),
  ).toBe(true);
  expect(() => assertFleetMailTools(owner)).toThrow("unavailable");
  expect(() => client.read(sourceId, query, () => {}, caller)).toThrow(
    "unavailable",
  );
  expect(client.sources()).toEqual([]);
});

it("refuses credential-bearing source fields and prevents callers from mutating its catalog", () => {
  const { client, state } = fixture();
  expect(() =>
    client.configure({
      ...state,
      sources: [{ ...source, credential: "fixture-secret" }],
    }),
  ).toThrow();
  client.sources()[0].sourceId = "";
  expect(client.sources()[0].sourceId).toBe(sourceId);
});
