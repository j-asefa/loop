import { z } from "zod";

// The state vocabulary and transition() edges have one owner. Atomic claim
// (queued → running) and guarded deferUndispatched (running → queued) remain
// lease operations in queue.ts. queued → failed rejects invalid, unleased
// saved work before dispatch; an old worker cannot use it after lease release.
const RUN_TRANSITIONS = {
  queued: ["cancelled", "paused", "failed"],
  running: [
    "completed",
    "failed",
    "pausing",
    "cancelled",
    "interrupted",
    "awaiting_approval",
  ],
  // pausing → completed: the work finished before reaching a pause boundary.
  pausing: ["paused", "completed", "failed", "cancelled", "interrupted"],
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
// The projections show unleased running/pausing work as waiting_children; it
// is a display state, never stored, but it is a value the public schemas carry.
export const RunDisplayState = z.union([RunState, z.literal("waiting_children")]);
export type RunDisplayState = z.infer<typeof RunDisplayState>;

export function legalRunTransition(from: RunState, to: RunState) {
  const destinations: readonly RunState[] = RUN_TRANSITIONS[from];
  return destinations.includes(to);
}

// Interrupted ends an execution attempt even though an explicit retry is legal.
export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
];
export const STARTED_RUN_STATES: readonly RunState[] = [
  "running",
  "pausing",
  "paused",
  "awaiting_approval",
];
export const ACTIVE_RUN_STATES: readonly RunState[] = [
  "queued",
  ...STARTED_RUN_STATES,
];
export const STARTED_RUN_DISPLAY_STATES: readonly string[] = [
  ...STARTED_RUN_STATES,
  "waiting_children",
];
export const ACTIVE_RUN_DISPLAY_STATES: readonly string[] = [
  "queued",
  ...STARTED_RUN_DISPLAY_STATES,
];
export const WORKING_RUN_DISPLAY_STATES: readonly string[] = [
  "running",
  "pausing",
  "waiting_children",
];
export const PENDING_RUN_DISPLAY_STATES: readonly string[] = [
  "queued",
  ...WORKING_RUN_DISPLAY_STATES,
];
const CHILD_WAIT_STATES: readonly string[] = ["running", "pausing"];
export function waitingForChildren(run: {
  state: string;
  worker_id?: string | null;
}) {
  return CHILD_WAIT_STATES.includes(run.state) && run.worker_id === null;
}
const sqlStates = (states: readonly string[]) =>
  `(${states.map((state) => `'${state}'`).join(",")})`;
export const ACTIVE_RUN_DISPLAY_STATES_SQL = sqlStates(
  ACTIVE_RUN_DISPLAY_STATES,
);
export const ACTIVE_RUN_STATES_SQL = sqlStates(ACTIVE_RUN_STATES);
export const EXECUTING_RUN_STATES_SQL = sqlStates(
  STARTED_RUN_STATES.filter((state) => state !== "paused"),
);
export const TERMINAL_RUN_STATES_SQL = sqlStates(TERMINAL_RUN_STATES);
export const WORKING_RUN_DISPLAY_STATES_SQL = sqlStates(
  WORKING_RUN_DISPLAY_STATES,
);
// Callers supply source-code SQL aliases, never request values.
export const publicRunStateSql = (alias: string) =>
  `CASE WHEN ${alias}.state IN ${sqlStates(CHILD_WAIT_STATES)} AND ${alias}.worker_id IS NULL THEN 'waiting_children' ELSE ${alias}.state END`;
