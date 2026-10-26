import { z } from "zod";
export const RunIdentity = z.object({
  id: z.string().min(1),
  owner_id: z.string().min(1),
});
import {
  maybeRun,
  parseRun,
  InvalidRow,
  RunPayload,
  type Run,
} from "./row-schemas.js";
import { queuedMailFailure, queuedMailReady } from "./agent-mail-policy.js";
import { NATIVE_CONNECTION_SQL } from "./native-connections.js";
import { Problem } from "./domain.js";
import { db, emit, id, now } from "./db.js";
import { completeCheckout, TERMINAL_STATES } from "./run-checkouts.js";
import type {
  RunEventState,
  RunEventPayload,
} from "../shared/workspace-events.js";

export type { Run } from "./row-schemas.js";
import { RunState, legalRunTransition } from "../shared/run-state.js";
export function enqueue(
  owner: string,
  input: string,
  key: string,
  options: {
    agent?: string;
    conversation?: string;
    kind?: string;
    payload?: unknown;
  } = {},
) {
  const payload = RunPayload.parse(
    options.payload === undefined ? {} : options.payload,
  );
  return db
    .transaction(() => {
      const prior = maybeRun(
        db
          .prepare("SELECT * FROM runs WHERE owner_id=? AND idempotency_key=?")
          .get(owner, key),
      );
      if (prior) {
        if (
          prior.input !== input ||
          prior.kind !== (options.kind || "agent") ||
          prior.agent_id !== (options.agent || null) ||
          prior.conversation_id !== (options.conversation || null) ||
          JSON.stringify(prior.payload) !== JSON.stringify(payload)
        )
          throw new Error(
            "Idempotency key was already used for another request",
          );
        return prior;
      }
      const pending = db
        .prepare(
          "SELECT count(*) n FROM runs WHERE owner_id=? AND state IN ('queued','running','pausing','paused','awaiting_approval')",
        )
        .get(owner) as { n: number };
      if (pending.n >= 100)
        throw new Problem(
          429,
          "This workspace has 100 pending runs. Finish or cancel some before adding more.",
        );
      const runId = id();
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)",
      ).run(
        runId,
        owner,
        options.agent || null,
        options.conversation || null,
        options.kind || "agent",
        input,
        key,
        JSON.stringify(payload),
        now(),
        now(),
      );
      emit(owner, runId, "queued", {});
      return parseRun(db.prepare("SELECT * FROM runs WHERE id=?").get(runId));
    })
    .immediate();
}
export function claim(
  worker: string,
  available: (run: Run) => boolean = () => true,
): Run | undefined {
  return db
    .transaction(() => {
      // Delegated work can pass queued tasks and released managers to unblock
      // their dependency chains. Pauses and approvals still block the queue.
      // Since this can run out of enqueue order, check every active lease too.
      // Background delegations (wait:false) block no one: their manager keeps
      // working and receives each result as a message.
      // Refuse obsolete mail even when another conversation would prevent its
      // claim. Otherwise it can remain a permanent queue barrier.
      const mailRuns = checkedRuns(
        db
          .prepare(
            `SELECT DISTINCT r.* FROM agent_mail m JOIN runs r ON ((m.run_id=r.id AND m.steering_id IS NULL) OR m.requeued_run_id=r.id) AND m.owner_id=r.owner_id
         WHERE r.state='queued' AND r.worker_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM native_dispatch d WHERE d.run_id=r.id)
         AND NOT EXISTS(SELECT 1 FROM native_dispatches d WHERE d.run_id=r.id)`,
          )
          .all(),
      );
      for (const queued of mailRuns) {
        const failure = queuedMailFailure(queued.id);
        if (failure) transition(queued, "cancelled", { message: failure });
      }
      const candidates = checkedRuns(
        db
          .prepare(
            `WITH candidates AS (
 SELECT runs.rowid AS queue_order, runs.*,
   (json_extract(runs.payload,'$.mailId') IS NOT NULL OR EXISTS(SELECT 1 FROM agent_mail m WHERE (m.run_id=runs.id AND m.steering_id IS NULL) OR m.requeued_run_id=runs.id)) AS is_mail,
   EXISTS(SELECT 1 FROM connections c WHERE c.id=json_extract(runs.payload,'$.connectionId')
     AND c.owner_id=runs.owner_id AND ${NATIVE_CONNECTION_SQL}) AS per_conversation
 FROM runs
 WHERE runs.state IN ('queued','running','pausing','paused','awaiting_approval')
)
SELECT r.* FROM candidates r WHERE
 ((r.state='queued' AND r.worker_id IS NULL AND NOT EXISTS(SELECT 1 FROM native_dispatch d WHERE d.run_id=r.id)) OR (r.state IN ('running','pausing') AND r.worker_id IS NULL AND (r.kind='workflow' OR EXISTS(SELECT 1 FROM delegations d WHERE d.parent_run_id=r.id AND d.background=0))))
 AND NOT EXISTS(SELECT 1 FROM candidates busy WHERE busy.owner_id=r.owner_id AND busy.agent_id=r.agent_id AND (r.is_mail OR busy.is_mail OR busy.conversation_id=r.conversation_id OR NOT r.per_conversation OR NOT busy.per_conversation) AND busy.id<>r.id AND ((busy.state IN ('running','pausing','awaiting_approval') AND busy.worker_id IS NOT NULL) OR ((r.is_mail OR busy.is_mail) AND busy.state IN ('running','pausing','paused','awaiting_approval'))))
 AND NOT EXISTS(SELECT 1 FROM candidates older WHERE older.owner_id=r.owner_id AND older.agent_id=r.agent_id AND (r.is_mail OR older.conversation_id=r.conversation_id OR NOT r.per_conversation OR (NOT older.is_mail AND NOT older.per_conversation)) AND older.state IN ('running','pausing','paused','awaiting_approval','queued') AND (COALESCE(older.queue_rank,older.created_at)<COALESCE(r.queue_rank,r.created_at) OR (COALESCE(older.queue_rank,older.created_at)=COALESCE(r.queue_rank,r.created_at) AND older.queue_order<r.queue_order))
   AND NOT (EXISTS(SELECT 1 FROM delegations delegated WHERE delegated.child_run_id=r.id AND delegated.background=0) AND (older.state='queued' OR (older.state='running' AND older.worker_id IS NULL AND EXISTS(SELECT 1 FROM delegations waiting WHERE waiting.parent_run_id=older.id AND waiting.background=0)))))
 AND NOT EXISTS(SELECT 1 FROM delegations d JOIN runs child ON child.id=d.child_run_id WHERE d.parent_run_id=r.id AND d.background=0 AND child.state IN ('queued','running','pausing','paused','awaiting_approval','waiting_children'))
 AND NOT EXISTS(SELECT 1 FROM workflow_steps s JOIN runs child ON child.id=s.child_run_id WHERE s.run_id=r.id AND child.state IN ('queued','running','pausing','paused','awaiting_approval'))
 ORDER BY COALESCE(r.queue_rank,r.created_at),r.queue_order`,
          )
          .all(),
      );
      const run = candidates.find((candidate) => {
        try {
          return queuedMailReady(candidate) && available(candidate);
        } catch (error) {
          if (!(error instanceof InvalidRow)) throw error;
          rejectInvalidRun(candidate, error);
          return false;
        }
      });
      if (!run) return;
      const state: RunState = run.state === "pausing" ? "pausing" : "running";
      db.prepare(
        "UPDATE runs SET state=?,worker_id=?,heartbeat=?,updated_at=?,active_since=COALESCE(active_since,?) WHERE id=?",
      ).run(state, worker, now(), now(), now(), run.id);
      emit(run.owner_id, run.id, "running", {
        resumed: run.state !== "queued",
      });
      return { ...run, state };
    })
    .immediate();
}
// A maintenance refusal is retryable only before the native backend has a
// dispatch receipt. CAS preserves cancellation and the original input identity.
export function deferUndispatched(run: Run, worker: string) {
  const changed = db
    .prepare(
      `UPDATE runs SET state='queued',worker_id=NULL,
    heartbeat=NULL,active_since=NULL,error=NULL,updated_at=? WHERE id=?
    AND state='running' AND worker_id=?
    AND NOT EXISTS(SELECT 1 FROM native_dispatch d WHERE d.run_id=runs.id)`,
    )
    .run(now(), run.id, worker).changes;
  if (changed) emit(run.owner_id, run.id, "queued", { maintenance: true });
  return !!changed;
}
export function transition(
  run: Pick<Run, "id" | "owner_id">,
  state: RunEventState,
  payload: RunEventPayload = {},
) {
  const changed = transitionState(run, state, payload);
  // A run that ended gets its checkout captured off the transition path:
  // read-only Git on a worktree can take a moment and must not hold the
  // database transaction or the caller.
  if (changed && TERMINAL_STATES.includes(state))
    void completeCheckout(run.id).catch(() => {});
  return changed;
}
function transitionState(
  run: Pick<Run, "id" | "owner_id">,
  state: RunEventState,
  payload: RunEventPayload,
) {
  return db
    .transaction(() => {
      const current = db
        .prepare("SELECT state FROM runs WHERE id=?")
        .get(run.id) as { state: string };
      if (!legalRunTransition(RunState.parse(current.state), state))
        return false;
      const time = now();
      db.prepare(
        `UPDATE runs SET state=?,updated_at=?,
      active_ms=active_ms+CASE WHEN active_since IS NOT NULL AND ? NOT IN ('running','pausing')
        THEN max(0,(CASE WHEN ?='interrupted' THEN min(?,COALESCE(heartbeat,?)) ELSE ? END)-active_since) ELSE 0 END,
      active_since=CASE WHEN ? IN ('running','pausing') THEN active_since ELSE NULL END
      WHERE id=?`,
      ).run(state, time, state, state, time, time, time, state, run.id);
      if (state === "queued")
        db.prepare(
          "UPDATE runs SET worker_id=NULL,heartbeat=NULL WHERE id=?",
        ).run(run.id);
      // The capture request is durable with the transition: if the process
      // stops before the capture claims it, reconciliation finds it.
      if (TERMINAL_STATES.includes(state))
        db.prepare(
          "UPDATE run_checkouts SET capture_pending=1 WHERE run_id=?",
        ).run(run.id);
      emit(run.owner_id, run.id, state, payload);
      return true;
    })
    .immediate();
}
export function recoverStale() {
  const stale = z
    .array(RunIdentity)
    .parse(
      db
        .prepare(
          "SELECT * FROM runs WHERE state IN ('running','pausing') AND worker_id IS NOT NULL AND heartbeat<?",
        )
        .all(now() - 60000),
    );
  for (const run of stale)
    transition(run, "interrupted", {
      message:
        "Worker stopped. Review partial output before retrying; external calls are not replayed automatically.",
    });
}

// Reject saved execution data before availability checks or a lease can expose
// it to an executor. A bad record cannot block unrelated queued conversations.
function checkedRuns(values: unknown[]): Run[] {
  return values.flatMap((value) => {
    try {
      return [parseRun(value)];
    } catch (error) {
      if (!(error instanceof InvalidRow)) throw error;
      const identity = RunIdentity.parse(value);
      rejectInvalidRun(identity, error);
      return [];
    }
  });
}
function rejectInvalidRun(
  run: Pick<Run, "id" | "owner_id">,
  error: InvalidRow,
) {
  const changed = db
    .prepare(
      "UPDATE runs SET error=? WHERE id=? AND owner_id=? AND worker_id IS NULL AND state IN ('queued','running','pausing')",
    )
    .run(error.message, run.id, run.owner_id).changes;
  if (changed) {
    emit(run.owner_id, run.id, "run.failed", {
      message: error.message,
      phase: "saved row validation",
    });
    transition(run, "failed");
  }
}
