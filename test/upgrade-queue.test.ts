import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "loop-upgrade-queue-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim, deferUndispatched } =
  await import("../src/server/queue");
const { tick } = await import("../src/server/worker");
const { nativeSessions } = await import("../src/server/native-sessions");
const { harnessUpgrades } = await import("../src/server/harness-upgrades");
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES('codex','local-workspace','openai','fixture','','connected','[]',?,0)",
).run(JSON.stringify({ loopHarness: "codex" }));
const outcome = (run: { id: string }) =>
  db
    .prepare("SELECT state,error,idempotency_key FROM runs WHERE id=?")
    .get(run.id);
afterAll(async () => {
  await nativeSessions.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("leaves held prompts queued while an unrelated runtime progresses, then executes the original identity", async () => {
  const queued = enqueue("local-workspace", "prompt", "maintenance", {
    payload: { agentId: "maintenance-fixture", name: "Fixture", provider: "openai", folderId: null, connectionId: "codex", model: "native-default", instructions: "" },
  });
  const unrelated = enqueue("other-owner", "unrelated", "unrelated", {
    kind: "diagnostic",
  });
  const release = harnessUpgrades.reserve("codex");
  try {
    const seen: string[] = [];
    await tick(async (run) => {
      seen.push(run.id);
    });
    expect(seen).toEqual([unrelated.id]);
    expect(outcome(queued)).toMatchObject({
      state: "queued",
      error: null,
      idempotency_key: "maintenance",
    });
    expect(
      await tick(async () => {
        throw new Error("must not start");
      }),
    ).toBe(false);
    release();
    await tick(async (run) => {
      seen.push(run.id);
    });
    expect(seen).toEqual([unrelated.id, queued.id]);
    expect(outcome(queued)).toMatchObject({ state: "completed" });
  } finally {
    release();
  }
});

it("returns a run claimed immediately before maintenance to the queue without failure", async () => {
  const queued = enqueue("local-workspace", "race", "race", {
    payload: { agentId: "maintenance-fixture", name: "Fixture", provider: "openai", folderId: null, connectionId: "codex", model: "native-default", instructions: "" },
  });
  await tick(async (run) => {
    const release = harnessUpgrades.reserve("codex");
    try {
      return await nativeSessions.execute(run);
    } finally {
      release();
    }
  });
  expect(outcome(queued)).toMatchObject({
    state: "queued",
    error: null,
    idempotency_key: "race",
  });
  await tick(async () => {});
  expect(outcome(queued)).toMatchObject({ state: "completed" });
});

it("never defers a run with an uncertain native dispatch or a cancelled run", () => {
  const r = enqueue("local-workspace", "uncertain", "uncertain");
  const claimed = claim("fixture")!;
  expect(claimed.id).toBe(r.id);
  db.prepare(
    "INSERT INTO native_dispatch(run_id,generation,digest,state,created_at) VALUES(?,'generation','digest','unknown',0)",
  ).run(r.id);
  expect(deferUndispatched(claimed, "fixture")).toBe(false);
  db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(r.id);
  expect(deferUndispatched(claimed, "fixture")).toBe(false);
});

it.each([false, true])("does not let a late worker failure end released work (reclaimed: %s)", async reclaimed => {
  const queued = enqueue("late-worker", "Unsent work", "late-" + reclaimed, { kind: "diagnostic" });
  await tick(async run => {
    expect(run.id).toBe(queued.id);
    const lease = db.prepare("SELECT worker_id FROM runs WHERE id=?").get(run.id) as { worker_id: string };
    expect(deferUndispatched(run, lease.worker_id)).toBe(true);
    if (reclaimed) expect(claim("replacement-worker")?.id).toBe(run.id);
    throw new Error("Late failure from the released attempt");
  });
  expect(outcome(queued)).toMatchObject({ state: reclaimed ? "running" : "queued", error: null });
  expect(db.prepare("SELECT worker_id FROM runs WHERE id=?").get(queued.id))
    .toEqual({ worker_id: reclaimed ? "replacement-worker" : null });
  expect(db.prepare("SELECT count(*) n FROM events WHERE run_id=? AND type IN ('failed','run.failed')").get(queued.id))
    .toEqual({ n: 0 });
  db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(queued.id);
});
