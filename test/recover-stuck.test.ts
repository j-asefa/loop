import { it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-recover-stuck-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
// This focused state test bypasses FK references for connections/agents.
db.pragma("foreign_keys = OFF");
const { enqueue } = await import("../src/server/queue");
const { recoverStuckRuns, sweepLeftoverToolCalls } =
  await import("../src/server/recover-stuck");
const { tick } = await import("../src/server/worker");
import * as approvalsQueries from "../src/server/sql/approvals";
import * as toolInvocationsQueries from "../src/server/sql/tool-invocations";
import * as nativeDispatchQueries from "../src/server/sql/native-dispatch";
import * as runsQueries from "../src/server/sql/runs";

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const owner = "stuck-owner";
function makeRun(key: string, args: Record<string, unknown> = {}) {
  return enqueue(owner, "input " + key, key, args);
}
function setState(run: { id: string }, state: string, worker?: string) {
  db.prepare("UPDATE runs SET state=?,worker_id=?,heartbeat=? WHERE id=?").run(
    state,
    worker ?? null,
    worker ? now() : null,
    run.id,
  );
}
function stateOf(run: { id: string }) {
  return (db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as any)
    .state;
}
function executingCall(run: { id: string }) {
  const approvalId = id();
  const invocationId = id();
  approvalsQueries.insert(
    db,
    approvalId,
    owner,
    run.id,
    "digest-" + id(),
    JSON.stringify({ tool: "t" }),
    "executing",
    now(),
    now() + 1000,
  );
  toolInvocationsQueries.insertPending(
    db,
    invocationId,
    owner,
    run.id,
    "conn",
    "",
    "call" + id(),
    "tool",
    "{}",
    approvalId,
    now(),
  );
  toolInvocationsQueries.startPending(db, invocationId);
  return { approvalId, invocationId };
}
function execState(table: string, rowId: string) {
  return (db.prepare(`SELECT state FROM ${table} WHERE id=?`).get(rowId) as any)
    .state;
}

it("marks approvals and tool invocations executing on a finished run as unknown (S1)", () => {
  const ended = makeRun("s1-ended");
  setState(ended, "interrupted");
  const live = makeRun("s1-live");
  setState(live, "running", "w1");
  const endedCalls = executingCall(ended);
  const liveCalls = executingCall(live);
  expect(execState("approvals", endedCalls.approvalId)).toBe("executing");
  expect(execState("tool_invocations", endedCalls.invocationId)).toBe(
    "executing",
  );

  sweepLeftoverToolCalls();

  // A call whose run is no longer executing is stored as unknown.
  expect(execState("approvals", endedCalls.approvalId)).toBe("unknown");
  expect(execState("tool_invocations", endedCalls.invocationId)).toBe(
    "unknown",
  );
  // A call still running (now/pausing leases it) is never swept.
  expect(execState("approvals", liveCalls.approvalId)).toBe("executing");
  expect(execState("tool_invocations", liveCalls.invocationId)).toBe(
    "executing",
  );
});

it("a crashed run's executing tool call becomes unknown once it is recovered (S1)", async () => {
  const run = makeRun("s1-crash");
  setState(run, "running", "wX"); // leased by a now-dead worker
  // A stale heartbeat makes the next tick's recoverStale end the run, which
  // fires the terminal-run trigger and moves the executing call to unknown.
  db.prepare("UPDATE runs SET heartbeat=? WHERE id=?").run(
    now() - 120000,
    run.id,
  );
  const calls = executingCall(run);
  expect(execState("tool_invocations", calls.invocationId)).toBe("executing");

  await tick(async () => undefined);

  expect(stateOf(run)).toBe("interrupted");
  expect(execState("approvals", calls.approvalId)).toBe("unknown");
  expect(execState("tool_invocations", calls.invocationId)).toBe("unknown");
});

it("fails a non-native run whose approvals all expired, and only those (S2)", () => {
  const expired = makeRun("s2-expired");
  setState(expired, "awaiting_approval", "w1");
  approvalsQueries.insert(
    db,
    id(),
    owner,
    expired.id,
    "digest-expired",
    JSON.stringify({ tool: "t" }),
    "pending",
    now() - 10000,
    now() - 1, // already expired
  );

  const unexpired = makeRun("s2-unexpired");
  setState(unexpired, "awaiting_approval", "w1");
  approvalsQueries.insert(
    db,
    id(),
    owner,
    unexpired.id,
    "digest-unexpired",
    JSON.stringify({ tool: "t" }),
    "pending",
    now(),
    now() + 60_000, // still actionable
  );

  const native = makeRun("s2-native");
  setState(native, "awaiting_approval", "w1");
  nativeDispatchQueries.insertUnknown(db, native.id, "gen", "hash", now());
  approvalsQueries.insert(
    db,
    id(),
    owner,
    native.id,
    "digest-native",
    JSON.stringify({ tool: "t" }),
    "pending",
    now() - 10000,
    now() - 1, // expired
  );

  recoverStuckRuns();

  // Only the non-native run with nothing left actionable leaves the queue.
  expect(stateOf(expired)).toBe("failed");
  expect(stateOf(unexpired)).toBe("awaiting_approval");
  // Native runs keep their own expiry handling; this run is not auto-failed.
  expect(stateOf(native)).toBe("awaiting_approval");
  // The reason is stored on the run so the Feed card shows it.
  expect(
    (db.prepare("SELECT error FROM runs WHERE id=?").get(expired.id) as any)
      .error,
  ).toMatch(/Approval expired/);
});

it("rechecks with decide's exact expiry boundary before failing (S2)", () => {
  const run = makeRun("s2-boundary");
  setState(run, "awaiting_approval", "w1");
  approvalsQueries.insert(
    db,
    id(),
    owner,
    run.id,
    "digest-boundary",
    JSON.stringify({ tool: "t" }),
    "pending",
    now() - 1000,
    5_000, // expires exactly at t=5000
  );
  // At exactly the expiry instant the approval is still decidable (decide
  // rejects only when expires_at < now), so the recheck keeps the run.
  expect(runsQueries.isStaleAwaitingApproval(db, 5_000, run.id, owner)).toBe(
    false,
  );
  // A millisecond later it is stale and would be failed.
  expect(runsQueries.isStaleAwaitingApproval(db, 5_001, run.id, owner)).toBe(
    true,
  );
});

it("a graceful shutdown does not interrupt non-native awaiting_approval runs (S3)", () => {
  const running = makeRun("s3-running");
  setState(running, "running", "w1");
  const nonNative = makeRun("s3-await");
  setState(nonNative, "awaiting_approval", "w1");
  const native = makeRun("s3-native-await");
  setState(native, "awaiting_approval", "w1");
  nativeDispatchQueries.insertUnknown(db, native.id, "gen", "hash", now());

  const shutdown = runsQueries
    .workerShutdownIdentities(db, "w1")
    .map((r) => r.id);
  // running runs and native awaiting_approval runs are interrupted...
  expect(shutdown).toContain(running.id);
  expect(shutdown).toContain(native.id);
  // ...but a non-native run that is only awaiting_approval survives shutdown,
  // matching what a crash would leave (approvable after restart).
  expect(shutdown).not.toContain(nonNative.id);
});
