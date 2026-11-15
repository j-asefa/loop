import type { Run } from "../../src/server/queue.js";
import type { RunExecutor } from "../../src/server/run-outcome.js";

// Tests that used to observe an executor-owned pause/lease release must now
// invoke the production worker's outcome application before inspecting it.
export async function settleRun(execute: RunExecutor, run: Run) {
  const { applyRunOutcome } = await import("../../src/server/worker.js");
  const outcome = await execute(run);
  applyRunOutcome(run, run.worker_id!, outcome);
  return outcome;
}
