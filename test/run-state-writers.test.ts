import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "loop-state-writers-"));
vi.stubEnv("LOOP_DATA_DIR", directory);
const { db, id, changes, deadlines } = await import("../src/server/db");
const { checkoutTransitions } = await import("../src/server/run-checkouts");
// Observe the durable request without launching a Git capture in this fixture.
const afterTransition = vi
  .spyOn(checkoutTransitions, "afterTransition")
  .mockImplementation(() => {});
const beforeTransition = vi.spyOn(checkoutTransitions, "beforeEvent");
const { enqueue, transition, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const { decide, requestApproval } = await import("../src/server/approvals");
const runsQueries = await import("../src/server/sql/runs");

afterAll(() => {
  vi.restoreAllMocks();
  changes.close();
  deadlines.close();
  db.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function fixture(state: string, dispatched = true) {
  const run = enqueue(id(), "State writer fixture", id());
  db.prepare(
    "UPDATE runs SET state=?,worker_id='worker',heartbeat=2000,active_since=1000,active_ms=10,updated_at=0 WHERE id=?",
  ).run(state, run.id);
  if (dispatched)
    db.prepare(
      "INSERT INTO native_dispatch VALUES(?, 'generation','digest','unknown',NULL,0)",
    ).run(run.id);
  db.prepare(
    "INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state) VALUES(?,?,?,'agent','conversation','','','','',0,0,0,'failed')",
  ).run(id(), run.owner_id, run.id);
  return run;
}
const row = (run: string) =>
  db
    .prepare(
      "SELECT state,worker_id,heartbeat,active_ms,active_since,updated_at FROM runs WHERE id=?",
    )
    .get(run);
const events = (run: string, type: string) =>
  db
    .prepare("SELECT payload FROM events WHERE run_id=? AND type=?")
    .all(run, type);

it.each(["running", "pausing", "awaiting_approval", "queued"])(
  "startup recovery interrupts dispatched %s through the hooks and accounts active time",
  (state) => {
    const run = fixture(state);
    new NativeSessions().recover();
    expect(row(run.id)).toEqual({
      state: "interrupted",
      worker_id: null,
      heartbeat: null,
      active_ms: 1010,
      active_since: null,
      updated_at: expect.any(Number),
    });
    expect(events(run.id, "interrupted")).toEqual([
      { payload: '{"native":true}' },
    ]);
    expect(
      db
        .prepare("SELECT capture_pending FROM run_checkouts WHERE run_id=?")
        .get(run.id),
    ).toEqual({ capture_pending: 1 });
    expect(afterTransition).toHaveBeenCalledWith(
      { id: run.id, owner_id: run.owner_id },
      "interrupted",
    );
    expect(
      claim("another-worker", (candidate) => candidate.id === run.id),
    ).toBeUndefined();
  },
);
it("startup recovery leaves undispatched queued and terminal runs unchanged", () => {
  const queued = fixture("queued", false),
    completed = fixture("completed");
  const prior = [row(queued.id), row(completed.id)];
  new NativeSessions().recover();
  expect([row(queued.id), row(completed.id)]).toEqual(prior);
  expect(events(queued.id, "interrupted")).toEqual([]);
  expect(events(completed.id, "interrupted")).toEqual([]);
});
it("recovery rolls back a refused edge and never transitions a mismatched owner", () => {
  const run = fixture("completed");
  const prior = row(run.id);
  const select = vi
    .spyOn(runsQueries, "orphanedNative")
    .mockReturnValue([{ id: run.id, owner_id: run.owner_id }]);
  try {
    expect(() => new NativeSessions().recover()).toThrow(
      "could not be interrupted",
    );
    expect(row(run.id)).toEqual(prior);
    expect(events(run.id, "interrupted")).toEqual([]);
    select.mockReturnValue([{ id: run.id, owner_id: id() }]);
    expect(() => new NativeSessions().recover()).toThrow(
      "could not be interrupted",
    );
    expect(row(run.id)).toEqual(prior);
  } finally {
    select.mockRestore();
  }
});
it.each(["approve", "reject"] as const)(
  "native %s resumes with timestamp, hooks and the existing decision event",
  (decision) => {
    const run = fixture("awaiting_approval");
    const approval = requestApproval(run, { tool: "fixture" });
    expect(() => decide(id(), approval.id, decision)).toThrow("Item not found");
    expect(decide(run.owner_id, approval.id, decision)).toEqual({ ok: true });
    expect(row(run.id)).toMatchObject({
      state: "running",
      updated_at: expect.any(Number),
    });
    expect((row(run.id) as { updated_at: number }).updated_at).toBeGreaterThan(
      0,
    );
    expect(beforeTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: run.id }),
      "running",
    );
    expect(afterTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: run.id }),
      "running",
    );
    expect(events(run.id, "running")).toEqual([{ payload: "{}" }]);
    expect(events(run.id, "approval.decided")).toEqual([
      {
        payload: JSON.stringify({
          approvalId: approval.id,
          decision,
          origin: "loop",
        }),
      },
    ]);
    expect(transition(run, "cancelled")).toBe(true);
  },
);
it("native approval refuses an illegal resume and rolls back its decision", () => {
  const run = fixture("awaiting_approval");
  const approval = requestApproval(run, { tool: "fixture" });
  const prior = row(run.id);
  const state = vi
    .spyOn(runsQueries, "ownedState")
    .mockReturnValue({ state: "cancelled" });
  try {
    expect(() => decide(run.owner_id, approval.id, "approve")).toThrow(
      "can no longer resume",
    );
    expect(row(run.id)).toEqual(prior);
    expect(
      db.prepare("SELECT state FROM approvals WHERE id=?").get(approval.id),
    ).toEqual({ state: "pending" });
    expect(events(run.id, "approval.decided")).toEqual([]);
  } finally {
    state.mockRestore();
  }
});
