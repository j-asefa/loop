import type { Run } from "./queue.js";
import type { RunState } from "../shared/run-state.js";
import { db } from "./db.js";
import * as runsQueries from "./sql/runs.js";

export type SettledRunOutcome =
  | { kind: "finished" }
  | { kind: "paused"; message?: string }
  | { kind: "cancelled" }
  | { kind: "waiting"; reason: "approval" | "children" | "pending-tool" }
  | {
      kind: "already-moved";
      reason:
        | "native-not-running"
        | "native-terminal-race"
        | "native-failed"
        | "native-interrupted"
        | "native-not-delivered"
        | "native-uncertain";
    };

export type RunOutcome =
  | SettledRunOutcome
  | {
      kind: "atomic";
      reason: "import-pause" | "delegation-wait";
      // These two existing transactions couple executor-owned bookkeeping to
      // a queue edge. The worker supplies the transition; the executor owns
      // its synchronous transaction and domain writes.
      settle: (apply: (outcome: SettledRunOutcome) => boolean) => void;
    };
export type RunExecutor = (run: Run) => Promise<RunOutcome>;

export function runBoundary(
  run: Pick<Run, "id" | "owner_id">,
):
  | { kind: "continue"; state: RunState }
  | { kind: "paused" }
  | { kind: "cancelled" } {
  const state = runsQueries.ownedState(db, run.id, run.owner_id)!.state;
  if (state === "pausing") return { kind: "paused" };
  if (state === "cancelled") return { kind: "cancelled" };
  return { kind: "continue", state };
}

export function pendingToolOutcome(run: Run): SettledRunOutcome {
  const boundary = runBoundary(run);
  if (boundary.kind === "cancelled") return boundary;
  return {
    kind: "waiting",
    reason:
      boundary.kind === "continue" && boundary.state === "awaiting_approval"
        ? "approval"
        : "pending-tool",
  };
}
