import {
  startMaintenance,
  reconcileWorkerCheckouts,
} from "./worker-maintenance.js";
import { reportBackgroundFailure } from "./background-failure.js";
import { RUN_HEARTBEAT_MS } from "./run-lease.js";
import { TERMINAL_RUN_STATES } from "../shared/run-state.js";
import * as connectionsQueries from "./sql/connections.js";
import * as agentCheckpointsQueries from "./sql/agent-checkpoints.js";
import * as importsQueries from "./sql/imports.js";
import * as workerHealthQueries from "./sql/worker-health.js";
import * as runsQueries from "./sql/runs.js";
import { ConnectionMetadata, readJson } from "./row-schemas.js";
import { UNKNOWN_RUN_FAILURE } from "../shared/run-errors.js";

import { errorFacts, errorSummary } from "../shared/diagnostics.js";
import { MAX_CONCURRENT_RUNS } from "../shared/concurrency.js";
import { recordTrace } from "./traces.js";
import { executeMcp } from "./mcp/routes.js";
import { closeFinishedSessions } from "./mcp/sessions.js";
import { Problem } from "./domain.js";
import { db, changes, emit, id, now } from "./db.js";
import { executeImport } from "./imports.js";
import { executeAgent } from "./agent-runtime.js";
import {
  claim,
  completeLeased,
  RunIdentity,
  deferUndispatched,
  recoverStale,
  transition,
  type Run,
} from "./queue.js";
import { RunDeferred } from "./run-deferred.js";
import { recoverStuckRuns, sweepLeftoverToolCalls } from "./recover-stuck.js";
import { harnessHolds } from "./harness-holds.js";
import { nativeSessions } from "./native-sessions.js";
import { observeProcess } from "./deployments.js";
import { heartbeatWrite } from "./heartbeat-write.js";
import {
  assertExecutionGeneration,
  executionGeneration,
} from "./execution-ownership.js";
const workerId = executionGeneration() ?? id();
export async function tick(
  execute: (run: Run) => Promise<void | boolean> = async (run) => {
    if (run.kind !== "diagnostic") throw new Error("Run type is not installed");
    emit(run.owner_id, run.id, "progress", {
      message: "Durable worker received the record",
    });
  },
  accepting: () => boolean = () => true,
) {
  if (!accepting()) return false;
  assertExecutionGeneration(workerId);
  await closeFinishedSessions();
  // A tick already in flight can resume after the scheduler quiesced. Check
  // again before recovery or any claim; clearing wake timers is insufficient.
  if (!accepting()) return false;
  assertExecutionGeneration(workerId);
  recoverStale();
  recoverStuckRuns();
  reconcileWorkerCheckouts();
  const run = claim(workerId, (candidate) => {
    if (!accepting()) return false;
    assertExecutionGeneration(workerId);
    const p = candidate.payload;
    const c = connectionsQueries.workerMetadata(
      db,
      p.connectionId || "",
      candidate.owner_id,
    ) as { metadata: string } | undefined;
    if (!c) return true;
    const harness =
      readJson(
        ConnectionMetadata.passthrough(),
        c.metadata,
        "connections",
        p.connectionId || "",
        "metadata",
      ).loopHarness || "";
    return !harnessHolds.first(harness);
  });
  if (!run) return false;
  const heartbeat = setInterval(
    () =>
      heartbeatWrite("run", () =>
        runsQueries.heartbeatLease(db, now(), run.id, workerId),
      ),
    RUN_HEARTBEAT_MS,
  );
  try {
    const complete = await execute(run);
    if (complete !== false) completeLeased(run, workerId);
  } catch (error) {
    if (error instanceof RunDeferred && deferUndispatched(run, workerId))
      return true;
    const checkpoint = agentCheckpointsQueries.workerStage(db, run.id) as
      { stage: string; round: number } | undefined;
    const phase =
      checkpoint?.stage === "tools"
        ? "tool execution"
        : checkpoint?.stage === "model"
          ? "provider response"
          : run.kind;
    // Unexpected failures retain their class/code, not arbitrary thrown data.
    // Provider and tool boundaries wrap their redacted messages in Problem.
    const message =
      error instanceof Problem
        ? error.message
        : errorSummary(error, [], false) === "Error"
          ? UNKNOWN_RUN_FAILURE
          : `Loop could not complete this run (${errorSummary(error, [], false)}). Review any saved progress before retrying.`;
    // A released or replaced lease cannot fail its former work. Keep the
    // lease check and failure transition atomic across API/worker processes.
    db.transaction(() => {
      const updated = runsQueries.leaseError(
        db,
        message,
        run.id,
        run.owner_id,
        workerId,
      );
      if (!updated.changes) return;
      recordTrace(run, "run:failure", {
        kind: "tool",
        title: "Run failure",
        content: message,
        metadata: {
          state: "failed",
          isError: true,
          failure: {
            phase,
            round: checkpoint?.round,
            ...errorFacts(error),
            ...(error instanceof Problem ? error.diagnostic : {}),
          },
        },
      });
      emit(run.owner_id, run.id, "run.failed", { message, phase });
      if (run.kind === "import")
        importsQueries.failOwned(db, run.payload.importId, run.owner_id);
      transition(run, "failed");
    }).immediate();
  } finally {
    clearInterval(heartbeat);
    await closeFinishedSessions();
  }
  return true;
}
export async function execute(run: Run) {
  if (run.kind === "diagnostic") {
    emit(run.owner_id, run.id, "progress", {
      message: "Durable worker received the record",
    });
    return;
  }
  if (run.kind === "mcp") return executeMcp(run);
  if (run.kind === "import") return executeImport(run);
  else return executeAgent(run);
}
export function startWorker() {
  assertExecutionGeneration(workerId);
  const stopObservation = observeProcess("worker");
  nativeSessions.recover();
  // Sweep calls a crashed earlier worker left 'executing' once here, after the
  // stale-run recovery, rather than scanning those tables on every tick.
  sweepLeftoverToolCalls();
  let active = 0;
  let stopping = false;
  const inflight = new Set<Promise<unknown>>();
  const heartbeat = () =>
    heartbeatWrite("worker", () =>
      workerHealthQueries.heartbeat(db, workerId, now()),
    );
  heartbeat();
  const stopMaintenance = startMaintenance((promise) => {
    inflight.add(promise);
    const settled = () => {
      inflight.delete(promise);
    };
    void promise.then(settled, settled);
  }, heartbeat);
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  const wake = () => {
    if (stopping || scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      if (stopping || active >= MAX_CONCURRENT_RUNS) return;
      active++;
      let claimed = false;
      const promise = tick(execute, () => !stopping)
        .then((result) => {
          claimed = result;
        })
        .catch((error) => reportBackgroundFailure("worker.tick", error))
        .finally(() => {
          active--;
          inflight.delete(promise);
          // A terminal publication can arrive while every slot is still held.
          // Wake again after release, but do not spin on an empty claim.
          if (claimed) wake();
        });
      inflight.add(promise);
    });
  };
  const unsubscribe = changes.subscribe(null, (events) => {
    if (
      events.some(
        ({ type }) =>
          ["queued", "running"].includes(type) ||
          TERMINAL_RUN_STATES.includes(type) ||
          type.startsWith("queue."),
      )
    )
      wake();
  });
  const scheduling = setInterval(wake, 2000);
  wake();
  const quiesce = () => {
    if (stopping) return;
    stopping = true;
    stopObservation();
    stopMaintenance();
    clearInterval(scheduling);
    unsubscribe();
    if (scheduled) clearImmediate(scheduled);
    // Shutdown owns this transition before native IO is terminated; a
    // resulting pipe failure must not reclassify an interrupted turn as failed.
    for (const run of RunIdentity.array().parse(
      runsQueries.workerShutdownIdentities(db, workerId),
    ))
      transition(run, "interrupted");
  };
  const stop = async () => {
    quiesce();
    await nativeSessions.close();
    await Promise.allSettled(inflight);
    await closeFinishedSessions();
    workerHealthQueries.remove(db, workerId);
  };
  return Object.assign(stop, { quiesce });
}

if (process.argv[1]?.match(/\/worker\.(ts|js)$/)) {
  throw new Error(
    "The companion host starts its worker through inherited IPC and an ownership lock.",
  );
}
