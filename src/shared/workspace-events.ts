import { z } from "zod";

export const WORKSPACE_COLLECTIONS = [
  "feed",
  "results",
  "runs",
  "approvals",
  "decisions",
  "activities",
  "saved",
  "later",
  "scheduled",
] as const;
export type WorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number];
const Id = z.string().min(1).max(1000);
const Text = z.string().max(8 * 1024 * 1024);
const Count = z.number().int().nonnegative().safe();
export const WorkspaceScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("run"), id: Id }),
  z.strictObject({ kind: z.literal("conversation"), id: Id }),
  z.strictObject({
    kind: z.literal("collection"),
    id: z.enum(["all", ...WORKSPACE_COLLECTIONS]),
  }),
]);
export type WorkspaceScope = z.infer<typeof WorkspaceScope>;

// Provider receipts and execution snapshots have provider-specific JSON fields.
// Bound their serialized size and depth without treating them as projection data.
const Json = z.unknown().refine((value) => {
  const seen = new Set<object>();
  function valid(item: unknown, depth: number): boolean {
    if (depth > 64) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    const ok =
      (Array.isArray(item) ||
        Object.getPrototypeOf(item) === Object.prototype ||
        Object.getPrototypeOf(item) === null) &&
      Object.values(item).every(
        (entry) => entry === undefined || valid(entry, depth + 1),
      );
    seen.delete(item);
    return ok;
  }
  try {
    return (
      valid(value, 0) &&
      new TextEncoder().encode(JSON.stringify(value)).length <= 8 * 1024 * 1024
    );
  } catch {
    return false;
  }
}, "Expected bounded JSON display data");
export const RunEventState = z.enum([
  "queued",
  "running",
  "pausing",
  "paused",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunEventState = z.infer<typeof RunEventState>;
export const RunEventPayload = z.strictObject({
  message: Text.optional(),
  reason: Text.optional(),
  approvalId: Id.optional(),
  stepId: Id.optional(),
  maintenance: z.boolean().optional(),
  resumed: z.boolean().optional(),
  native: z.boolean().optional(),
  preview: z.boolean().optional(),
});
export type RunEventPayload = z.infer<typeof RunEventPayload>;
// Match NativeSessions ingress: provider IDs and list lengths are constrained
// by the serialized request/event budget, not the internal Loop ID contract.
export const MAX_NATIVE_REQUEST_BYTES = 64000;
export const MAX_NATIVE_EVENT_BYTES = 256000;
const NativeId = z.string().max(MAX_NATIVE_EVENT_BYTES);
const NativeRequest = z.strictObject({
  id: NativeId,
  kind: z.enum(["approval", "question"]),
  title: Text,
  detail: Text,
  choices: z.array(Text).max(MAX_NATIVE_REQUEST_BYTES).optional(),
  allow: Text.optional(),
  questions: z
    .array(
      z.strictObject({
        id: NativeId,
        title: Text,
        options: z.array(Text).max(MAX_NATIVE_REQUEST_BYTES).optional(),
        multiple: z.boolean().optional(),
        secret: z.boolean().optional(),
      }),
    )
    .max(MAX_NATIVE_REQUEST_BYTES)
    .optional(),
}).refine(
  (request) =>
    new TextEncoder().encode(JSON.stringify(request)).length <= MAX_NATIVE_REQUEST_BYTES,
  "Native request exceeds its ingress byte budget",
);
const NativeEvent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("status"),
    status: z.enum([
      "starting",
      "ready",
      "running",
      "awaiting-input",
      "completed",
      "interrupted",
      "failed",
      "stopped",
    ]),
    detail: Text.optional(),
    recoverable: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("metadata"),
    nativeSession: NativeId,
    billing: z
      .strictObject({
        mode: z.enum(["subscription", "existing"]),
        description: Text,
        provider: Text.optional(),
        model: Text.optional(),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal("item"),
    item: z.strictObject({
      id: NativeId,
      kind: z.enum(["user", "assistant", "tool", "notice"]),
      text: Text,
      title: Text.optional(),
      status: Text.optional(),
      phase: z.enum(["commentary", "final_answer"]).optional(),
    }),
  }),
  z.strictObject({ type: z.literal("delta"), id: NativeId, text: Text }),
  z.strictObject({ type: z.literal("request"), request: NativeRequest }),
  z.strictObject({ type: z.literal("resolved"), id: NativeId }),
  z.strictObject({ type: z.literal("error"), message: Text }),
]).refine(
  (event) =>
    new TextEncoder().encode(JSON.stringify(event)).length <= MAX_NATIVE_EVENT_BYTES,
  "Native event exceeds its ingress byte budget",
);
const Empty = z.strictObject({});
const Approval = z.union([
  z.strictObject({ approvalId: Id, request: Json.optional() }),
  z.strictObject({ decisionId: Id, title: Text }),
]);
const Message = z.strictObject({ messageId: Id });
// Native tools use an empty string when the completed call has no artifact.
const Tool = z.strictObject({ tool: Id, artifactId: z.union([Id, z.literal("")]) });
const Payloads = {
  queued: RunEventPayload,
  running: RunEventPayload,
  pausing: RunEventPayload,
  paused: RunEventPayload,
  awaiting_approval: RunEventPayload,
  completed: RunEventPayload,
  failed: RunEventPayload,
  cancelled: RunEventPayload,
  interrupted: RunEventPayload,
  waiting_children: Empty,
  progress: z.strictObject({ message: Text }),
  "run.failed": z.strictObject({ message: Text, phase: z.string().max(300) }),
  "agent_mail.sent": z.strictObject({
    mailId: Id,
    threadId: Id,
    delivery: z.enum(["new_turn", "queued", "steered"]),
  }),
  "agent_mail.held": z.strictObject({ mailId: Id, threadId: Id }),
  "import.progress": z.strictObject({ completed: Count, total: Count }),
  "workflow.step.completed": z.strictObject({
    stepId: Id,
    childRunId: Id,
    conversationId: Id.nullable(),
  }),
  "workflow.step.started": z.strictObject({
    stepId: Id,
    childRunId: Id,
    conversationId: Id,
    agent: Text,
  }),
  "workflow.completed": z.strictObject({
    outputs: z.record(z.string().max(1000), Text),
  }),
  "feed.changed": z.strictObject({ artifactId: Id, hidden: z.boolean() }),
  "approval.auto_approved": Approval,
  "approval.requested": z.strictObject({ approvalId: Id, request: Json }),
  "approval.decided": z.strictObject({
    approvalId: Id,
    decision: z.enum(["approve", "reject"]),
    origin: z.literal("loop"),
  }),
  "tool.failed": Tool,
  "tool.completed": Tool,
  "artifact.published": z.strictObject({ artifactId: Id }),
  "activity.updated": z.strictObject({
    key: z.string().min(1).max(4000),
    kind: z.enum([
      "plan",
      "tool",
      "file_change",
      "output",
      "settings",
      "commands",
      "capabilities",
    ]),
    sequence: Count,
  }),
  "steering.pending": z.strictObject({ messageId: Id, steeringId: Id }),
  "steering.delivered": Message,
  "steering.failed": Message,
  "message.started": z.strictObject({
    messageId: Id,
    round: Count,
    snapshot: Json,
  }),
  "message.delta": z.union([
    z.strictObject({ messageId: Id, text: Text }),
    z.strictObject({ messageId: Id, native: z.literal(true) }),
  ]),
  "message.completed": Message,
  "trace.updated": z.strictObject({ round: Count }),
  "provider.receipt": z.strictObject({
    usage: Json.optional(),
    externalId: z.string().max(1000).optional(),
  }),
  "attention.dismissed": Empty,
  "queue.reordered": z.strictObject({ direction: z.enum(["up", "down"]) }),
  "queue.edited": Empty,
  "native.usage": z.strictObject({
    usage: z.strictObject({ input_tokens: Count, output_tokens: Count }),
  }),
  "native.event": z.strictObject({
    conversationId: Id,
    generation: Id,
    event: NativeEvent,
  }),
};
function variant<K extends keyof typeof Payloads>(type: K) {
  return z.strictObject({
    type: z.literal(type),
    payload: Payloads[type],
    scope: WorkspaceScope,
  });
}
export const EmittedWorkspaceEvent = z.discriminatedUnion("type", [
  variant("queued"),
  variant("running"),
  variant("pausing"),
  variant("paused"),
  variant("awaiting_approval"),
  variant("completed"),
  variant("failed"),
  variant("cancelled"),
  variant("interrupted"),
  variant("waiting_children"),
  variant("progress"),
  variant("run.failed"),
  variant("agent_mail.sent"),
  variant("agent_mail.held"),
  variant("import.progress"),
  variant("workflow.step.completed"),
  variant("workflow.step.started"),
  variant("workflow.completed"),
  variant("feed.changed"),
  variant("approval.auto_approved"),
  variant("approval.requested"),
  variant("approval.decided"),
  variant("tool.failed"),
  variant("tool.completed"),
  variant("artifact.published"),
  variant("activity.updated"),
  variant("steering.pending"),
  variant("steering.delivered"),
  variant("steering.failed"),
  variant("message.started"),
  variant("message.delta"),
  variant("message.completed"),
  variant("trace.updated"),
  variant("provider.receipt"),
  variant("attention.dismissed"),
  variant("queue.reordered"),
  variant("queue.edited"),
  variant("native.usage"),
  variant("native.event"),
]);
type EmittedWorkspaceEvent = z.infer<typeof EmittedWorkspaceEvent>;
// A discriminated tuple keeps existing durable v2 payloads unchanged while
// correlating each emitted type with exactly its own payload at compile time.
export type WorkspaceEmission = {
  [K in EmittedWorkspaceEvent["type"]]: [
    type: K,
    payload: Extract<EmittedWorkspaceEvent, { type: K }>["payload"],
  ];
}[EmittedWorkspaceEvent["type"]];
export const WorkspaceEvent = z.discriminatedUnion("type", [
  ...EmittedWorkspaceEvent.options,
  z.strictObject({ type: z.literal("invalidate"), scope: WorkspaceScope }),
]);
export type WorkspaceEvent = z.infer<typeof WorkspaceEvent>;
export function invalidate(
  scope: WorkspaceScope = { kind: "collection", id: "all" },
): WorkspaceEvent {
  return { type: "invalidate", scope };
}
export function eventScope(type: string, run: string): WorkspaceScope {
  // Legacy events describe changes to a run, not authoritative projection
  // rows. Collection invalidations are explicit (including revision hints).
  return { kind: "run", id: run };
}
export function parseEmission(run: string, type: string, payload: unknown) {
  const event = EmittedWorkspaceEvent.parse({
    type,
    payload,
    scope: eventScope(type, run),
  });
  if (new TextEncoder().encode(JSON.stringify(event)).length > 16 * 1024 * 1024)
    throw new Error("Workspace event exceeds its durable size bound");
  return event;
}
export function historicalEvent(row: {
  run_id: string;
  type: string;
  payload: string | null;
}): WorkspaceEvent {
  if (row.payload === null) {
    // Payload was bounded in SQL before materialization. Preserve its run scope.
    const scope = WorkspaceScope.safeParse(eventScope(row.type, row.run_id));
    return Object.hasOwn(Payloads, row.type) && scope.success
      ? invalidate(scope.data)
      : invalidate();
  }
  try {
    return parseEmission(row.run_id, row.type, JSON.parse(row.payload));
  } catch {
    return invalidate();
  }
}
export function parseWorkspaceEvent(value: unknown): WorkspaceEvent {
  const parsed = WorkspaceEvent.safeParse(value);
  return parsed.success ? parsed.data : invalidate();
}
export const WorkspaceCapabilities = z.strictObject({
  invalidations: z.enum(["partial", "complete"]),
  deadlines: z.boolean(),
  transcript: z.enum(["snapshot", "delta"]),
  feed: z.enum(["snapshot", "delta"]),
  results: z.enum(["snapshot", "delta"]),
});
export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilities>;
export const PARTIAL_WORKSPACE_CAPABILITIES: WorkspaceCapabilities = {
  invalidations: "partial",
  deadlines: false,
  transcript: "snapshot",
  feed: "snapshot",
  results: "snapshot",
};
export const WorkspaceFrameV3 = z.discriminatedUnion("type", [
  z.strictObject({
    v: z.literal(3),
    type: z.literal("reset"),
    epoch: z.string().min(1).max(200),
    cursor: Count,
    build: z.string().max(1000),
    buildIdentity: z.unknown(),
    capabilities: WorkspaceCapabilities,
  }),
  z.strictObject({
    v: z.literal(3),
    type: z.literal("events"),
    epoch: z.string().min(1).max(200),
    cursor: Count,
    events: z
      .array(
        z.strictObject({
          id: Count,
          event: z.unknown().transform(parseWorkspaceEvent),
        }),
      )
      .min(1)
      .max(110),
  }),
]);
export type WorkspaceFrameV3 = z.infer<typeof WorkspaceFrameV3>;
