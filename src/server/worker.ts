import { errorFacts, errorSummary } from "../../runtime/diagnostics.mjs";
import { MAX_CONCURRENT_RUNS } from "../../runtime/concurrency.mjs";
import { recordTrace } from "./traces.js";
import { companionMode } from "./profile.js";
import { executeMcp } from "./mcp/routes.js";
import { closeFinishedSessions } from "./mcp/sessions.js";
import { executeWorkflow } from "./workflows/runtime.js";
import { Problem } from "./domain.js";
import { db, emit, id, now } from "./db.js";
import { executeImport } from "./imports.js";
import { indexPending } from "./search.js";
import { executeAgent } from "./agent-runtime.js";
import { claim, recoverStale, transition, type Run } from "./queue.js";
import { migrateMcpUrlCredentials } from "./mcp/credentials.js";
import {
  observeEnvironments,
  stopObservingEnvironments,
} from "./hapi/observe.js";
import { reconcileNative } from "./hapi/adapter.js";
import { refreshEnvironment, environment } from "./hapi/environments.js";
import { indexMemory } from "./memory.js";
import { nativeSessions } from "./native-sessions.js";
import { deliverNotifications } from "./notifications.js";
import { deliverScheduledSends, surfaceLater } from "./mobile-return.js";
import { cleanupMergedWorkspaces } from "./workspace-cleanup.js";
const workerId = id();
export async function tick(
  execute: (run: Run) => Promise<void | boolean> = async (run) => {
    if (run.kind !== "diagnostic") throw new Error("Run type is not installed");
    emit(run.owner_id, run.id, "progress", {
      message: "Durable worker received the record",
    });
  },
) {
  await closeFinishedSessions();
  recoverStale();
  const run = claim(workerId);
  if (!run) return false;
  const heartbeat = setInterval(
    () =>
      db
        .prepare("UPDATE runs SET heartbeat=? WHERE id=? AND worker_id=?")
        .run(now(), run.id, workerId),
    10000,
  );
  try {
    const complete = await execute(run);
    if (complete !== false) transition(run, "completed");
  } catch (error) {
    const checkpoint = db
      .prepare("SELECT stage,round FROM agent_checkpoints WHERE run_id=?")
      .get(run.id) as { stage: string; round: number } | undefined;
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
        : `The run stopped during ${phase} (${errorSummary(error, [], false)}). Open failure details to inspect the saved progress.`;
    const updated = db
      .prepare(
        "UPDATE runs SET error=? WHERE id=? AND state IN ('running','pausing','awaiting_approval')",
      )
      .run(message, run.id);
    if (updated.changes) {
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
    }
    if (run.kind === "import")
      db.prepare(
        "UPDATE imports SET status='failed' WHERE id=? AND owner_id=?",
      ).run(JSON.parse(run.payload).importId, run.owner_id);
    transition(run, "failed");
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
  if (run.kind === "workflow") return executeWorkflow(run);
  if (run.kind === "import") return executeImport(run);
  else return executeAgent(run);
}
export function startWorker() {
  migrateMcpUrlCredentials();
  if (companionMode) nativeSessions.recover();
  let active = 0;
  let stopping = false;
  const inflight = new Set<Promise<unknown>>();
  const heartbeat = () =>
    db
      .prepare("INSERT OR REPLACE INTO worker_health VALUES(?,?)")
      .run(workerId, now());
  heartbeat();
  const hapiTimers: ReturnType<typeof setInterval>[] = [];
  let cleaning = false;
  const cleanupController = new AbortController();
  hapiTimers.push(
    setInterval(
      () => {
        if (cleaning || stopping) return;
        cleaning = true;
        const promise = cleanupMergedWorkspaces(cleanupController.signal)
          .catch(() => {})
          .finally(() => {
            cleaning = false;
            inflight.delete(promise);
          });
        inflight.add(promise);
      },
      5 * 60 * 1000,
    ),
  );
  let notifying = false;
  hapiTimers.push(
    setInterval(() => {
      if (notifying || stopping) return;
      notifying = true;
      // Surface Later items and submit due scheduled messages before
      // delivery, so their pushes go out in the same pass.
      try {
        surfaceLater();
      } catch {}
      try {
        deliverScheduledSends();
      } catch {}
      void deliverNotifications()
        .catch(() => {})
        .finally(() => {
          notifying = false;
        });
    }, 3000),
  );
  hapiTimers.push(setInterval(() => void reconcileNative(), 2500));
  hapiTimers.push(
    setInterval(() => {
      try {
        observeEnvironments();
      } catch {}
    }, 5000),
  );
  hapiTimers.push(setInterval(() => void indexMemory(), 5000));
  hapiTimers.push(
    setInterval(() => {
      const environments = db
        .prepare(
          "SELECT owner_id,host_id FROM execution_environments WHERE revoked_at IS NULL",
        )
        .all() as any[];
      void Promise.allSettled(
        environments.map((e) =>
          refreshEnvironment(environment(e.owner_id, e.host_id)),
        ),
      );
    }, 10000),
  );
  const health = setInterval(heartbeat, 5000);
  const index = setInterval(() => void indexPending().catch(() => {}), 5000);
  const scheduling = setInterval(
    () => {
      if (stopping || active >= MAX_CONCURRENT_RUNS) return;
      active++;
      const promise = tick(execute)
        .catch(() => {})
        .finally(() => {
          active--;
          inflight.delete(promise);
        });
      inflight.add(promise);
    },
    companionMode ? 100 : 500,
  );
  return async () => {
    stopping = true;
    cleanupController.abort();
    hapiTimers.forEach(clearInterval);
    stopObservingEnvironments();
    clearInterval(health);
    clearInterval(index);
    clearInterval(scheduling);
    await nativeSessions.close();
    // Stop explicit API/tool work too, so shutdown cannot wait on provider IO.
    for (const run of db
      .prepare(
        "SELECT * FROM runs WHERE worker_id=? AND state IN ('running','pausing','awaiting_approval')",
      )
      .all(workerId) as Run[])
      transition(run, "interrupted");
    await Promise.allSettled(inflight);
    await closeFinishedSessions();
    db.prepare("DELETE FROM worker_health WHERE id=?").run(workerId);
  };
}

if (process.argv[1]?.match(/\/worker\.(ts|js)$/)) {
  if (companionMode)
    throw new Error("The companion host owns its in-process worker.");
  const stop = startWorker();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void stop());
  console.log("Loop worker ready");
}
