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
import { nativeSessions } from "./native-sessions.js";
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
    db.prepare(
      "UPDATE runs SET error=? WHERE id=? AND state IN ('running','pausing','awaiting_approval')",
    ).run(
      error instanceof Problem
        ? error.message
        : "Execution failed. Check connection and retry explicitly.",
      run.id,
    );
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
  const health = setInterval(heartbeat, 5000);
  const index = setInterval(() => void indexPending().catch(() => {}), 5000);
  const scheduling = setInterval(
    () => {
      if (stopping || active >= (companionMode ? 32 : 10)) return;
      if (companionMode && active - nativeSessions.waiting >= 10) return;
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
