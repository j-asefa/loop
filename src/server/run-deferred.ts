// Only throw before any native spawn/send can have happened. The worker may
// return that undispatched run to the queue without replaying an external effect.
export class RunDeferred extends Error {}
