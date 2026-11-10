import { queuedMailReady } from "./agent-mail-policy.js";
import { createRunQueue } from "./queue-machine.js";
import { prepareClaim } from "./queue-policy.js";
import { checkoutTransitions } from "./run-checkouts.js";
import { enqueueStoppedWebhooks } from "./webhook-outbox.js";
import { db } from "./db.js";

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
  beforeEvent: checkoutTransitions.beforeEvent,
  afterEvent: (event) => enqueueStoppedWebhooks(db, event),
  afterTransition: checkoutTransitions.afterTransition,
});
