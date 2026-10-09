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
import {
  claim,
  deferUndispatched,
  recoverStale,
  transition,
  type Run,
} from "./queue.js";
import { RunDeferred } from "./run-deferred.js";
import { harnessUpgrades } from "./harness-upgrades.js";
import { migrateMcpUrlCredentials } from "./mcp/credentials.js";
import { indexMemory } from "./memory.js";
import { nativeSessions } from "./native-sessions.js";
import { deliverNotifications } from "./notifications.js";
import { deliverScheduledSends, surfaceLater } from "./mobile-return.js";
import { cleanupMergedWorkspaces } from "./workspace-cleanup.js";
import { pollWatches } from "./pr-watches.js";
import { refreshDueFeeds } from "./news.js";
import { runDueDigests } from "./feed-digests.js";
import { matchWatches } from "./feed-watches.js";
import { sweepAgentMail } from "./agent-mail.js";
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
  const run = claim(workerId, (candidate) => {
    const p = JSON.parse(candidate.payload);
    const c = db
      .prepare("SELECT metadata FROM connections WHERE id=? AND owner_id=?")
      .get(p.connectionId || "", candidate.owner_id) as
      { metadata: string } | undefined;
    return !c || !harnessUpgrades.busy(JSON.parse(c.metadata).loopHarness);
  });
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
    if (error instanceof RunDeferred && deferUndispatched(run, workerId))
      return true;
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
  const maintenanceTimers: ReturnType<typeof setInterval>[] = [];
  let cleaning = false;
  const cleanupController = new AbortController();
  maintenanceTimers.push(
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
  maintenanceTimers.push(
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
      // Results of background delegations, and team messages whose task
      // ended before reading them.
      try {
        sweepAgentMail();
      } catch {}
      void deliverNotifications()
        .catch(() => {})
        .finally(() => {
          notifying = false;
        });
    }, 3000),
  );
  // Watched pull requests; each one is read about once a minute.
  maintenanceTimers.push(
    setInterval(() => {
      if (stopping) return;
      for (const poll of [pollWatches]) {
        const promise = poll()
          .catch(() => {})
          .finally(() => inflight.delete(promise));
        inflight.add(promise);
      }
    }, 15_000),
  );
  // Social feeds. Reading them here rather than when a page asks means
  // opening Social is served from the store, and stays fresh with the tab
  // closed. Digests and watches run once the reads have settled, so they
  // see what the pass brought in rather than what was there before it; the
  // whole sequence is one tracked job, so stopping waits for all of it.
  maintenanceTimers.push(
    setInterval(() => {
      if (stopping) return;
      const promise = refreshDueFeeds()
        .then(() => {
          try {
            runDueDigests();
          } catch {}
          try {
            matchWatches();
          } catch {}
        })
        .catch(() => {})
        .finally(() => inflight.delete(promise));
      inflight.add(promise);
    }, 60_000),
  );
  maintenanceTimers.push(setInterval(() => void indexMemory(), 5000));
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
    maintenanceTimers.forEach(clearInterval);
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
