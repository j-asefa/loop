import * as runsQueries from "./sql/runs.js";
import { z } from "zod";
import {
  recordFleetEffect,
  recordFleetEffectEdit,
} from "./fleet-effect-authorizations.js";
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
import { Problem } from "./domain.js";
import { db, emit, id, now } from "./db.js";
import { completeCheckout, TERMINAL_STATES } from "./run-checkouts.js";
import type {
  RunEventState,
  RunEventPayload,
} from "../shared/workspace-events.js";

export type { Run } from "./row-schemas.js";
import { RunState, legalRunTransition } from "../shared/run-state.js";
import { enqueueStoppedWebhooks } from "./webhook-outbox.js";
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
      const prior = maybeRun(runsQueries.byIdempotency(db, owner, key));
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
      const pending = runsQueries.pendingCount(db, owner) as { n: number };
      if (pending.n >= 100)
        throw new Problem(
          429,
          "This workspace has 100 pending runs. Finish or cancel some before adding more.",
        );
      const runId = id();
      recordFleetEffect(owner, "run", runId);
      runsQueries.insertQueued(
        db,
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
      return parseRun(runsQueries.get(db, runId));
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
      const candidates = runsQueries.claimCandidates(db, rejectInvalidRun);
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
      runsQueries.claimLease(db, state, worker, now(), now(), now(), run.id);
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
  const changed = runsQueries.deferUndispatched(
    db,
    now(),
    run.id,
    worker,
  ).changes;
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
      const current = runsQueries.ownedState(db, run.id, run.owner_id) as
        { state: string } | undefined;
      if (!current || !legalRunTransition(RunState.parse(current.state), state))
        return false;
      // Resuming existing work introduces a new deferred effect even if a local
      // device created it. Preserve the resuming peer alongside its creator.
      if (state === "queued")
        recordFleetEffectEdit(run.owner_id, "run", run.id);
      const time = now();
      runsQueries.transitionState(
        db,
        state,
        time,
        state,
        state,
        time,
        time,
        time,
        state,
        run.id,
      );
      if (state === "queued") runsQueries.clearLease(db, run.id);
      // The capture request is durable with the transition: if the process
      // stops before the capture claims it, reconciliation finds it.
      if (TERMINAL_STATES.includes(state))
        db.prepare(
          "UPDATE run_checkouts SET capture_pending=1 WHERE run_id=?",
        ).run(run.id);
      const event = emit(run.owner_id, run.id, state, payload);
      enqueueStoppedWebhooks(db, event);
      return true;
    })
    .immediate();
}
export function recoverStale() {
  const stale = z
    .array(RunIdentity)
    .parse(runsQueries.staleIdentities(db, now() - 60000));
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
  const changed = runsQueries.markInvalidUnleased(
    db,
    error.message,
    run.id,
    run.owner_id,
  ).changes;
  if (changed) {
    emit(run.owner_id, run.id, "run.failed", {
      message: error.message,
      phase: "saved row validation",
    });
    transition(run, "failed");
  }
}
