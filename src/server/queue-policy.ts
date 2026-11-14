import { db } from "./db.js";
import * as mailQueries from "./sql/agent-mail.js";
import * as continuationQueries from "./sql/review-continuations.js";
import { queuedMailFailure } from "./agent-mail-policy.js";
import { InvalidRow } from "./row-schemas.js";
import type { ClaimActions } from "./queue-machine.js";

export function prepareClaim({ transition, rejectInvalidRun }: ClaimActions) {
  // Refuse obsolete mail even when another conversation would prevent its
  // claim. Otherwise it can remain a permanent queue barrier.
  const mailRuns = mailQueries.queuedRuns(db, rejectInvalidRun);
  // Stopped/obsolete work may already be terminal; refusal leaves it stopped.
  for (const stopped of continuationQueries.stopped(db))
    transition(stopped, "cancelled", {
      reason:
        "The requesting task stopped; review status remains available for explicit recovery.",
    });
  for (const queued of mailRuns) {
    try {
      const failure = queuedMailFailure(queued.id);
      // A prior cancellation in this claim transaction may already stop it.
      if (failure) transition(queued, "cancelled", { message: failure });
    } catch (error) {
      if (!(error instanceof InvalidRow)) throw error;
      rejectInvalidRun(queued, error);
    }
  }
}
