import { queuedMailReady } from "./agent-mail-policy.js";
import { createRunQueue } from "./queue-machine.js";
import { prepareClaim } from "./queue-policy.js";
import { publishCompletedRunResult } from "./result-publication.js";
import { checkoutTransitions } from "./run-checkouts.js";

export { RunIdentity } from "./queue-machine.js";
export type { Run } from "./row-schemas.js";

export const {
  enqueue,
  claim,
  deferUndispatched,
  transition,
  completeLeased,
  recoverStale,
} = createRunQueue({
  beforeClaim: prepareClaim,
  ready: queuedMailReady,
  beforeEvent(run, state) {
    checkoutTransitions.beforeEvent(run, state);
    if (state === "completed") {
      publishCompletedRunResult(run.id, run.owner_id);
    }
  },
  afterTransition: checkoutTransitions.afterTransition,
});
