import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop-app-contracts-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_URL = "http://127.0.0.1";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { config, setWorkspaceUrl } = await import("../src/server/config");
const { enqueue, transition } = await import("../src/server/queue");
const { observeProcess } = await import("../src/server/deployments");
const { closeExecution } = await import("../src/server/execution-client");
const { nativeSessions } = await import("../src/server/native-sessions");
const { OWNER: owner } = await import("../src/server/workspace-identity");
const { app } = await import("../src/server/index");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
config.port = (server.address() as AddressInfo).port;
const origin = "http://127.0.0.1:" + config.port;
setWorkspaceUrl(origin);
const stopObservation = observeProcess("api");

afterAll(async () => {
  stopObservation();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeExecution();
  await nativeSessions.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  headers: Record<string, string> = {},
  raw?: string,
) {
  const payload =
    raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise<{ status: number; data: any; headers: unknown }>(
    (resolve, reject) => {
      const req = httpRequest(
        origin + "/api" + path,
        {
          method,
          headers: {
            "content-type": "application/json",
            origin,
            ...(payload === undefined
              ? {}
              : { "content-length": Buffer.byteLength(payload) }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode!,
              data: text ? JSON.parse(text) : null,
              headers: res.headers,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    },
  );
}
function valid(
  contract: RouteContract,
  response: { status: number; data: unknown },
  status = 200,
) {
  expect(response.status).toBe(status);
  expect(contract.response.parse(response.data)).toEqual(response.data);
}
async function invalid(
  path: string,
  body: unknown,
  method: string,
  headers = {},
) {
  const response = await request(path, body, method, headers);
  expect(response.status, path).toBe(400);
  expect(response.data).toEqual({ error: expect.any(String) });
}

it("no longer serves workflow routes to an authenticated owner", async () => {
  expect((await request("/teams")).status).toBe(200);
  for (const [path, body] of [
    ["/workflows", undefined],
    ["/workflows/validate", { source: "{}" }],
    ["/workflows", { source: "{}" }],
    ["/workflows/fixture", undefined],
    [
      "/workflows/fixture/run",
      { version: 1, inputs: {}, idempotencyKey: "fixture" },
    ],
    ["/runs/fixture/steps", undefined],
  ] as const)
    expect((await request(path, body)).status, path).toBe(404);
});

it("projects public discovery, paired identity, health, build and actual diagnostic/event rows", async () => {
  for (const contract of [
    workspaceApi.capabilities,
    workspaceApi.authSession,
    workspaceApi.build,
  ]) {
    valid(contract, await request(contract.path));
    await invalid(contract.path, {}, "GET");
  }
  expect((await request("/capabilities")).data.personalApprovalDetails).toBe(
    true,
  );
  expect((await request("/auth/get-session")).data).toEqual({
    mode: "paired",
    user: { id: owner, name: "Your workspace" },
  });
  expect((await request("/build")).data.processes).toEqual([
    expect.objectContaining({ role: "api" }),
  ]);
  valid(workspaceApi.health, await request("/health"), 503);
  db.prepare("INSERT INTO worker_health VALUES(?,?)").run(
    "fixture-worker",
    Date.now(),
  );
  valid(workspaceApi.health, await request("/health"));
  await invalid("/health", {}, "GET");

  const key = id();
  const created = await request("/diagnostic", { key });
  valid(workspaceApi.diagnostic, created);
  const replay = await request("/diagnostic", { key });
  expect(replay.data.id).toBe(created.data.id);
  const array = await request("/diagnostic", []);
  valid(workspaceApi.diagnostic, array);
  expect(transition(array.data, "cancelled")).toBe(true);
  await invalid("/diagnostic", null, "POST");
  const foreign = enqueue("another-owner", "Foreign diagnostic", id());
  const events = await request("/events?after=0");
  valid(workspaceApi.events, events);
  expect(events.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        run_id: created.data.id,
        subject_kind: "run",
        subject_id: created.data.id,
        type: "queued",
        payload: expect.any(String),
      }),
    ]),
  );
  expect(
    events.data.some((row: { run_id: string }) => row.run_id === foreign.id),
  ).toBe(false);
  const after = events.data.at(-1).id;
  expect((await request("/events?after=" + after)).data).toEqual([]);
  await invalid("/events", {}, "GET");
  expect(transition(created.data, "cancelled")).toBe(true);
  expect(transition(foreign, "cancelled")).toBe(true);
});
