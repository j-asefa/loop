import { waitingForChildren } from "../shared/run-state.js";
import { runPreview } from "./run-preview.js";
import * as approvalsQueries from "./sql/approvals.js";
import * as runsQueries from "./sql/runs.js";
import * as connectionsQueries from "./sql/connections.js";
import * as nativeDispatchQueries from "./sql/native-dispatch.js";
import { z } from "zod";

import { db, emit, now } from "./db.js";
import { ownedRun, ownedRunControl, Problem } from "./domain.js";
import { RunIdentity, transition } from "./queue.js";
import type { RunEventPayload } from "../shared/workspace-events.js";

// Call inside the root's transaction. A damaged child payload cannot prevent
// healthy siblings from stopping, and a foreign link never grants authority.
function cancelChildren(
  owner: string,
  root: string,
  reason: RunEventPayload = {},
) {
  const pending = [root],
    visited = new Set<string>();
  while (pending.length) {
    const parent = pending.pop()!;
    if (visited.has(parent)) continue;
    visited.add(parent);
    approvalsQueries.rejectPending(db, owner, parent);
    const children = z
      .array(RunIdentity)
      .parse(runsQueries.cancellableChildren(db, owner, parent));
    for (const child of children) {
      // A child already terminal needs no transition; still visit descendants.
      transition(child, "cancelled", reason);
      pending.push(child.id);
    }
  }
}

export function cancelRun(owner: string, runId: string) {
  return db
    .transaction(() => {
      const run = ownedRunControl(runId, owner);
      if (!transition(run, "cancelled"))
        throw new Problem(
          409,
          "That action is not available in the current state",
        );
      cancelChildren(owner, run.id);
      return { ok: true };
    })
    .immediate();
}

// Decide from the row as it is now, in the same transaction as the change: a
// worker may claim the run between the request's read and this write. A
// leased run stays pausing so its worker stops at the next boundary; only a
// run with no worker (queued, or waiting for its children) pauses at once.
export function controlRun(
  owner: string,
  runId: string,
  action: "pause" | "resume",
) {
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      if (action === "resume") {
        if (run.state !== "paused")
          throw new Problem(
            409,
            "Only a paused run can be resumed. Use a new retry for interrupted work.",
          );
        // A paused run that already saved its answer only needs completing.
        if (!transition(run, run.result ? "completed" : "queued"))
          throw new Problem(409, "Run has already changed");
        return { ok: true };
      }
      // Checked on the current row: a worker may have claimed a queued native
      // run since the request read it, and a native turn cannot be suspended.
      if (
        ["running", "awaiting_approval"].includes(run.state) &&
        (nativeDispatchQueries.exists(db, run.id) ||
          connectionsQueries.nativeOwned(
            db,
            run.payload.connectionId ?? null,
            run.owner_id,
          ))
      )
        throw new Problem(
          409,
          "This harness cannot suspend an active native turn. Interrupt this run, then send a follow-up; other agents keep running.",
        );
      const next = run.state === "queued" ? "paused" : "pausing";
      if (!transition(run, next))
        throw new Problem(
          409,
          "That action is not available in the current state",
        );
      if (
        next === "pausing" &&
        waitingForChildren(run) &&
        !transition(run, "paused")
      )
        throw new Problem(409, "Run has already changed");
      return { ok: true };
    })
    .immediate();
}

export function dismissRun(owner: string, runId: string) {
  return db
    .transaction(() => {
      const run = ownedRunControl(runId, owner);
      if (run.attention_dismissed_at) return { ok: true };
      const stopped = ["failed", "interrupted"].includes(run.state);
      const waiting =
        ["queued", "paused", "awaiting_approval"].includes(run.state) ||
        (run.state === "running" && run.worker_id === null);
      if (!stopped && !waiting)
        throw new Problem(
          409,
          "This task has changed. Refresh before dismissing it.",
        );
      if (waiting) {
        const reason = { reason: "Dismissed by you" };
        if (!transition(run, "cancelled", reason))
          throw new Problem(409, "Run has already changed");
        cancelChildren(owner, run.id, reason);
      }
      runsQueries.dismissAttention(db, now(), run.id, owner);
      emit(owner, run.id, "attention.dismissed", {});
      return { ok: true };
    })
    .immediate();
}

export function listRuns(owner: string, teams: string[] = [], active = false) {
  return runsQueries.attention(db, owner, teams, active).map((row) => {
    const run = z.object({ id: z.string() }).passthrough().parse(row);
    const { latest, artifact } = runPreview(db, owner, run.id);
    return {
      ...run,
      ...(latest ? { preview: latest } : {}),
      preview_artifact: artifact,
    };
  });
}
