import { z } from "zod";

// The state vocabulary and transition() edges have one owner. Atomic claim
// (queued → running) and guarded deferUndispatched (running → queued) remain
// lease operations in queue.ts. queued → failed rejects invalid, unleased
// saved work before dispatch; an old worker cannot use it after lease release.
export const RUN_TRANSITIONS = {
  queued: ["cancelled", "paused", "failed"],
  running: [
    "completed",
    "failed",
    "pausing",
    "cancelled",
    "interrupted",
    "awaiting_approval",
  ],
  pausing: ["paused", "failed", "cancelled", "interrupted"],
  paused: ["queued", "completed", "cancelled"],
  awaiting_approval: [
    "queued",
    "running",
    "cancelled",
    "failed",
    "interrupted",
    "completed",
  ],
  interrupted: ["queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const;
export type RunState = keyof typeof RUN_TRANSITIONS;
export const RunState = z.enum(
  Object.keys(RUN_TRANSITIONS) as [RunState, ...RunState[]],
);
export function legalRunTransition(from: RunState, to: RunState) {
  const destinations: readonly RunState[] = RUN_TRANSITIONS[from];
  return destinations.includes(to);
}
