import * as approvalsQueries from "./sql/approvals.js";
import * as toolInvocationsQueries from "./sql/tool-invocations.js";
import * as runsQueries from "./sql/runs.js";
import { db, now } from "./db.js";
import { transition, RunIdentity } from "./queue.js";

// An approval or tool invocation left 'executing' by a crashed worker becomes
// 'unknown' once its run is no longer actively executing (recovered or ended),
// so the stored state reflects the uncertain outcome (#355 S1). A completing
// call is harmless whether it wins or loses the race (its result overwrites).
// Runs once at worker startup, after the stale-run recovery, not every tick.
export function sweepLeftoverToolCalls() {
  const note =
    "Uncertain external outcome. The worker stopped before a result; nothing was replayed.";
  // Same JSON shapes the migration-151 trigger stores for an 'unknown'
  // outcome (including failure as an object, as the broker writes), so any
  // later reader of the column sees one shape.
  approvalsQueries.sweepExecuting(
    db,
    JSON.stringify({ error: note, failure: { outcome: "unknown" } }),
  );
  toolInvocationsQueries.sweepExecuting(
    db,
    JSON.stringify({
      isError: true,
      content: [{ type: "text", text: note }],
      failure: { outcome: "unknown" },
    }),
  );
}

// A non-native run stuck in 'awaiting_approval' with only expired pending
// approvals leaves it (marked failed) so it stops holding the agent's queue
// and the Feed stops hiding the approval (#355 S2). The call is never run.
// Runs on each tick, but only matches runs awaiting_approval with an expired,
// nothing-actionable approval; it rechecks each run inside the same
// transaction as the fail so a concurrent approve is never overwritten.
export function recoverStuckRuns() {
  const message = "Approval expired. Start a new run after review.";
  const stuck = RunIdentity.array().parse(
    runsQueries.staleAwaitingApproval(db, now()),
  );
  for (const run of stuck) {
    db.transaction(() => {
      if (
        runsQueries.isStaleAwaitingApproval(db, now(), run.id, run.owner_id)
      ) {
        // Store the reason on the run so the Feed card shows it, as a
        // rejection would.
        runsQueries.setError(db, message, run.id);
        // The recheck above holds awaiting_approval in this transaction;
        // that state always permits failed, so refusal is unreachable.
        transition(run, "failed", { message });
      }
    }).immediate();
  }
}
