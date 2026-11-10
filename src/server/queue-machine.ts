import { STALE_RUN_LEASE_MS } from "./run-lease.js";
import * as runsQueries from "./sql/runs.js";
import { z } from "zod";
import { recordEffect, recordEffectEdit } from "./effect-authority.js";
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
import { Problem } from "../shared/problem.js";
import { db, emit, id, now } from "./db.js";
import type {
  RunEventState,
  RunEventPayload,
} from "../shared/workspace-events.js";

import { RunState, legalRunTransition } from "../shared/run-state.js";
type Identity = Pick<Run, "id" | "owner_id">;
export type ClaimActions = {
  transition: (
    run: Identity,
    state: RunEventState,
    payload?: RunEventPayload,
  ) => boolean;
  rejectInvalidRun: (run: Identity, error: InvalidRow) => void;
};
type QueueHooks = {
  beforeClaim: (actions: ClaimActions) => void;
  ready: (run: Run) => boolean;
  beforeEvent: (run: Identity, state: RunEventState) => void;
  afterEvent: (event: number | bigint) => void;
  afterTransition: (run: Identity, state: RunEventState) => void;
};

export function createRunQueue(hooks: QueueHooks) {
  function enqueue(
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
        recordEffect(owner, "run", runId);
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
  function claim(
    worker: string,
    available: (run: Run) => boolean = () => true,
  ): Run | undefined {
    return db
      .transaction(() => {
        hooks.beforeClaim({ transition, rejectInvalidRun });
        const candidates = runsQueries.claimCandidates(db, rejectInvalidRun);
        const run = candidates.find((candidate) => {
          try {
            return hooks.ready(candidate) && available(candidate);
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
  function deferUndispatched(run: Run, worker: string) {
    const changed = runsQueries.deferUndispatched(
      db,
      now(),
      run.id,
      worker,
    ).changes;
    if (changed) emit(run.owner_id, run.id, "queued", { maintenance: true });
    return !!changed;
  }
  function transition(
    run: Pick<Run, "id" | "owner_id">,
    state: RunEventState,
    payload: RunEventPayload = {},
  ) {
    const changed = transitionState(run, state, payload);
    if (changed) hooks.afterTransition(run, state);
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
        if (
          !current ||
          !legalRunTransition(RunState.parse(current.state), state)
        )
          return false;
        // Resuming existing work introduces a new deferred effect even if a local
        // device created it. Preserve the resuming peer alongside its creator.
        if (state === "queued") recordEffectEdit(run.owner_id, "run", run.id);
        const time = now();
        runsQueries.transitionState(db, state, time, run.id);
        if (state === "queued") runsQueries.clearLease(db, run.id);
        hooks.beforeEvent(run, state);
        const event = emit(run.owner_id, run.id, state, payload);
        hooks.afterEvent(event);
        return true;
      })
      .immediate();
  }
  /**
   * Complete a run this worker still leases; a worker whose lease was released
   * or replaced cannot finish the run. A pause that arrived after the runtime's
   * last boundary pauses a saved answer (resume completes it without running
   * again); work without a saved answer has finished, so it completes.
   */
  function completeLeased(run: Pick<Run, "id" | "owner_id">, worker: string) {
    return db
      .transaction(() => {
        const current = runsQueries.leasedState(
          db,
          run.id,
          run.owner_id,
          worker,
        );
        if (!current) return false;
        if (current.state === "pausing" && current.result !== null)
          return transition(run, "paused", {
            message:
              "Response completed and saved. Resume to mark this run complete.",
          });
        return transition(run, "completed");
      })
      .immediate();
  }
  function recoverStale() {
    const stale = z
      .array(RunIdentity)
      .parse(runsQueries.staleIdentities(db, now() - STALE_RUN_LEASE_MS));
    for (const run of stale)
      transition(run, "interrupted", {
        message:
          "Worker stopped. Review partial output before retrying; external calls are not replayed automatically.",
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

  return {
    enqueue,
    claim,
    deferUndispatched,
    transition,
    completeLeased,
    recoverStale,
  };
}
