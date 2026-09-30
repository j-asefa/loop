import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-hapi-queue-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { provisionEnvironment } = await import("../src/server/hapi/environments");
const { ensureSession } = await import("../src/server/hapi/adapter");
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function fixture(hapi = true, capacity = 32) {
  const owner = id(), connectionId = id();
  db.prepare("INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES(?,?,'openai','Queue fixture','','connected',?,?)")
    .run(connectionId, owner, JSON.stringify(hapi ? { backend: "hapi" } : {}), now());
  db.prepare("UPDATE connections SET models=? WHERE id=?").run(JSON.stringify([{ id: "fixture" }]), connectionId);
  const agent = createAgent(owner, { name: "queue-" + randomBytes(8).toString("hex"), connectionId, model: "fixture" });
  const host = provisionEnvironment(owner, {
    name: "Queue fixture", url: "https://worker.invalid:3010", instanceId: "i-" + randomBytes(8).toString("hex"),
    namespace: id(), credential: "a".repeat(48), certificateFingerprint: "AB:".repeat(31) + "AB", capacity,
  });
  db.prepare("UPDATE execution_environments SET state='online',last_seen=? WHERE host_id=?").run(now(), host);
  const conversation = () => {
    const cid = id();
    db.prepare("INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Queue',?)").run(cid, owner, agent.id, now());
    return cid;
  };
  const make = (cid: string, route: "metadata" | "payload" | "both" = "both") => enqueue(owner, "test", id(), {
    agent: agent.id, conversation: cid,
    payload: {
      ...(route !== "payload" ? { connectionId } : {}),
      ...(hapi && route !== "metadata" ? { execution: { backend: "hapi", environmentId: host, flavor: "codex", billing: {} } } : {}),
    },
  });
  return { conversation, make };
}

it.each(["metadata", "payload", "both"] as const)("orders HAPI turns while allowing other conversations via %s", (route) => {
  const f = fixture(), cid = f.conversation();
  const first = f.make(cid, route), follow = f.make(cid, route), other = f.make(f.conversation(), route);
  expect(claim("first")?.id).toBe(first.id);
  // Production sendPrepared releases the worker lease while HAPI keeps running.
  db.prepare("UPDATE runs SET worker_id=NULL WHERE id=?").run(first.id);
  expect(claim("other")?.id).toBe(other.id);
  expect(claim("blocked")).toBeUndefined();
  transition(first, "completed");
  expect(claim("follow")?.id).toBe(follow.id);
  transition(follow, "completed"); transition(other, "completed");
});

it("keeps Loop-managed conversations serialized per agent", () => {
  const f = fixture(false), first = f.make(f.conversation()), other = f.make(f.conversation());
  expect(claim("first")?.id).toBe(first.id);
  expect(claim("blocked")).toBeUndefined();
  transition(first, "completed");
  expect(claim("other")?.id).toBe(other.id);
  transition(other, "completed");
});

it("keeps capacity one while admitting the resident conversation", () => {
  const f = fixture(true, 1), cid = f.conversation(), first = f.make(cid);
  expect(claim("first")?.id).toBe(first.id);
  ensureSession(first);
  transition(first, "completed");
  const other = f.make(f.conversation()), follow = f.make(cid);
  expect(claim("resident")?.id).toBe(follow.id);
  transition(follow, "completed");
  expect(claim("full")).toBeUndefined();
  db.prepare("UPDATE native_sessions SET state='closed' WHERE conversation_id=?").run(cid);
  expect(claim("free")?.id).toBe(other.id);
  transition(other, "completed");
});

it("claims through the active-state index with 200,000 completed runs", () => {
  const f = fixture(false), run = f.make(f.conversation());
  db.prepare(`WITH RECURSIVE history(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<200000
  ) INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,created_at,updated_at)
    SELECT 'history-' || ? || '-' || n, ?, ?, ?, 'agent', 'finished', 'completed',
      'history-' || n, '{}', ?-1, ?-1 FROM history`).run(
      run.id, run.owner_id, run.agent_id, run.conversation_id, run.created_at, run.created_at,
    );
  const prepare = vi.spyOn(db, "prepare");
  try {
    expect(claim("history-regression")?.id).toBe(run.id);
    const sql = prepare.mock.calls.find(([sql]) => sql.startsWith("WITH candidates AS"))![0];
    const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all() as { detail: string }[];
    expect(plan.some(({ detail }) => /SEARCH runs USING INDEX run_queue/.test(detail))).toBe(true);
    expect(plan.some(({ detail }) => /SCAN runs\b/.test(detail))).toBe(false);
    transition(run, "completed");
    expect(claim("empty-history")).toBeUndefined();
  } finally {
    prepare.mockRestore();
    db.prepare("DELETE FROM runs WHERE owner_id=?").run(run.owner_id);
  }
});
