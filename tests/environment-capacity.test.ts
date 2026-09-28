import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-capacity-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { provisionEnvironment } =
  await import("../src/server/hapi/environments");
const { ensureSession } = await import("../src/server/hapi/adapter");
const { enqueue, claim } = await import("../src/server/queue");
const identity = {
  name: "Capacity fixture",
  url: "https://worker.invalid:3010",
  instanceId: "i-1234567890abcdef0",
  namespace: "capacity-fixture",
  credential: "a".repeat(48),
  certificateFingerprint: "AB:".repeat(31) + "AB",
};
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("upgrades an existing verified environment to 32, preserves its identity and allows explicit smaller caps", () => {
  const host = provisionEnvironment("alice", { ...identity, capacity: 4 });
  const before = db
    .prepare("SELECT * FROM execution_environments WHERE host_id=?")
    .get(host) as any;
  expect(provisionEnvironment("alice", identity)).toBe(host);
  expect(
    db
      .prepare("SELECT * FROM execution_environments WHERE host_id=?")
      .get(host),
  ).toEqual({ ...before, capacity: 32 });
  for (const capacity of [0, -1, 33, 1.5, NaN])
    expect(() =>
      provisionEnvironment("alice", { ...identity, capacity }),
    ).toThrow(/capacity/);
  expect(() =>
    provisionEnvironment("bob", { ...identity, capacity: 8 }),
  ).toThrow(/identity/);
  expect(() =>
    provisionEnvironment("alice", {
      ...identity,
      credential: "b".repeat(48),
      capacity: 8,
    }),
  ).toThrow(/identity/);
  expect(
    (
      db
        .prepare("SELECT capacity FROM execution_environments WHERE host_id=?")
        .get(host) as any
    ).capacity,
  ).toBe(32);
  provisionEnvironment("alice", { ...identity, capacity: 8 });
  expect(
    (
      db
        .prepare("SELECT capacity FROM execution_environments WHERE host_id=?")
        .get(host) as any
    ).capacity,
  ).toBe(8);
});

it("admits 32 resident sessions and queues a new conversation until one closes", () => {
  const host = provisionEnvironment("alice", identity);
  db.prepare(
    "UPDATE execution_environments SET state='online',last_seen=? WHERE host_id=?",
  ).run(now(), host);
  const runs = Array.from({ length: 33 }, (_, n) => {
    const conversation = id();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'alice','Capacity',?)",
    ).run(conversation, now());
    return enqueue("alice", "Capacity task", "capacity-" + n, {
      conversation,
      payload: {
        connectionId: "fixture",
        execution: {
          backend: "hapi",
          environmentId: host,
          flavor: "codex",
          billing: {},
        },
      },
    });
  });
  for (let n = 0; n < 32; n++) {
    const run = claim("capacity-worker")!;
    expect(run.id).toBe(runs[n].id);
    ensureSession(run);
  }
  expect(claim("capacity-worker")).toBeUndefined();
  db.prepare(
    "UPDATE native_sessions SET state='closed' WHERE conversation_id=?",
  ).run(runs[0].conversation_id);
  expect(claim("capacity-worker")?.id).toBe(runs[32].id);
});
