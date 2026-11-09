import type Database from "better-sqlite3";
import * as continuationQueries from "./sql/review-continuations.js";
import * as agentCheckpointsQueries from "./sql/agent-checkpoints.js";
import * as nativeDispatchQueries from "./sql/native-dispatch.js";
// A swap only crosses threads: each conversation's turns run in the order
// they were sent, because its model history is built in that order.
export function canSwapQueuedRuns(
  peers: { id: string; conversation_id: string | null }[],
  index: number,
  other: number,
) {
  return (
    index >= 0 &&
    other >= 0 &&
    other < peers.length &&
    peers[other].conversation_id !== peers[index].conversation_id
  );
}

export function editableQueuedRun(
  db: Database.Database,
  run: {
    id: string;
    worker_id?: string | null;
    active_since?: number | null;
    state: string;
  },
) {
  return (
    run.state === "queued" &&
    run.worker_id === null &&
    !run.active_since &&
    !continuationQueries.byRun(db, run.id) &&
    !agentCheckpointsQueries.exists(db, run.id) &&
    !nativeDispatchQueries.exists(db, run.id)
  );
}
