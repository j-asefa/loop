import { z } from "zod";
import { ProjectedMessage, MessageAppend, MessageRemoval } from "./transcript-projection.js";

export const WORKSPACE_COLLECTIONS = [
  "feed",
  "results",
  "runs",
  "approvals",
  "decisions",
  "activities",
  "usage",
  "saved",
  "later",
  "scheduled",
  "metadata",
  "mail",
  "social",
  "pulls",
] as const;
export type WorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number];
const Id = z.string().min(1).max(1000);
const Text = z.string().max(8 * 1024 * 1024);
const Count = z.number().int().nonnegative().safe();
export const WorkspaceScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("run"), id: Id }),
  z.strictObject({ kind: z.literal("conversation"), id: Id }),
  z.strictObject({ kind: z.literal("connection"), id: Id }),
  z.strictObject({
    kind: z.literal("collection"),
    id: z.enum(["all", ...WORKSPACE_COLLECTIONS]),
  }),
]);
export type WorkspaceScope = z.infer<typeof WorkspaceScope>;

export const WORKSPACE_SUBJECTS = [
  "run", "conversation", "message", "artifact", "approval", "decision",
  "later", "scheduled_send", "mail_thread", "connection", "agent", "folder",
  "team", "social", "collection",
] as const;
export const WorkspaceSubject = z.strictObject({ kind: z.enum(WORKSPACE_SUBJECTS), id: Id });
export type WorkspaceSubject = z.infer<typeof WorkspaceSubject>;
const Scopes = z.array(WorkspaceScope).min(1).max(32);
const Invalidation = z.strictObject({ scope: WorkspaceScope, scopes: Scopes.optional() });
const Tombstone = Invalidation.extend({ removed: WorkspaceSubject });
const Deadline = z.strictObject({ serverNow: Count, nextDeadline: Count.nullable() });
const Decision = z.strictObject({
  decisionId: Id, conversationId: Id, runId: Id, generation: Id,
  nativeId: z.string().max(256000), state: z.string(), request: z.unknown(),
});


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
import { RunState } from "./run-state.js";
export const RunEventState = RunState;
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
  completionUrl: z.string().url().startsWith("https://").optional(),
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
  "connection.status": z.strictObject({ status: z.string().min(1).max(100) }),
  "reverse.settled": z.strictObject({ callId: Id }),
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
  "feed.card": z.strictObject({
    conversationId: Id, cardKey: z.string().max(200),
    kind: z.enum(["thread", "result", "idle"]), removed: z.boolean(), card: Json.nullable(),
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
    MessageAppend,
    z.strictObject({ messageId: Id, text: Text }),
    z.strictObject({ messageId: Id, native: z.literal(true) }),
  ]),
  "message.upsert": z.strictObject({ message: ProjectedMessage }),
  "message.remove": MessageRemoval,
  "decision.pending": Decision,
  "decision.deciding": Decision,
  "decision.resolved": Decision,
  "decision.expired": Decision,
  "decision.unknown": Decision,
  "decision.remove": Decision,
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
    subject: WorkspaceSubject.optional(),
    scopes: Scopes.optional(),
  });
}
export const EmittedWorkspaceEvent = z.discriminatedUnion("type", [
  variant("connection.status"),
  variant("reverse.settled"),
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
  variant("feed.card"),
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
  variant("message.upsert"),
  variant("message.remove"),
  variant("decision.pending"),
  variant("decision.deciding"),
  variant("decision.resolved"),
  variant("decision.expired"),
  variant("decision.unknown"),
  variant("decision.remove"),
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
type LegacyEmission = {
  [K in Exclude<EmittedWorkspaceEvent["type"], "connection.status">]: [
    type: K,
    payload: Extract<EmittedWorkspaceEvent, { type: K }>["payload"],
  ];
}[Exclude<EmittedWorkspaceEvent["type"], "connection.status">];
export type WorkspaceEmission = LegacyEmission
  | [type: "invalidate", payload: z.infer<typeof Invalidation>]
  | [type: "tombstone", payload: z.infer<typeof Tombstone>]
  | [type: "deadline", payload: z.infer<typeof Deadline>];
export const WorkspaceEvent = z.discriminatedUnion("type", [
  ...EmittedWorkspaceEvent.options,
  z.strictObject({ type: z.literal("invalidate"), scope: WorkspaceScope, subject: WorkspaceSubject.optional(), scopes: Scopes.optional() }),
  z.strictObject({ type: z.literal("tombstone"), scope: WorkspaceScope, subject: WorkspaceSubject, scopes: Scopes.optional(), removed: WorkspaceSubject }),
  z.strictObject({ type: z.literal("deadline"), scope: WorkspaceScope, subject: WorkspaceSubject, ...Deadline.shape }),
]);
export type WorkspaceEvent = z.infer<typeof WorkspaceEvent>;
export function invalidate(
  scope: WorkspaceScope = { kind: "collection", id: "all" },
  subject?: WorkspaceSubject,
): WorkspaceEvent {
  return { type: "invalidate", scope, ...(subject ? { subject } : {}) };
}
export function eventScopes(event: WorkspaceEvent): WorkspaceScope[] {
  return [event.scope, ...("scopes" in event ? event.scopes ?? [] : [])];
}
export function eventScope(type: string, run: string | null, subject?: string | WorkspaceSubject): WorkspaceScope {
  if (typeof subject === "object") {
    if (["run", "conversation", "connection"].includes(subject.kind))
      return { kind: subject.kind as "run" | "conversation" | "connection", id: subject.id };
    if (subject.kind === "collection") {
      const parsed = WorkspaceScope.safeParse(subject);
      if (parsed.success) return parsed.data;
    }
  }
  return type === "connection.status" && typeof subject === "string"
    ? { kind: "connection", id: subject }
    : run ? { kind: "run", id: run } : { kind: "collection", id: "all" };
}
export function parseEmission(run: string | null, type: string, payload: unknown, input?: string | WorkspaceSubject): WorkspaceEvent {
  const subject = typeof input === "object" ? WorkspaceSubject.parse(input)
    : { kind: type === "connection.status" ? "connection" as const : "run" as const, id: input ?? run ?? "" };
  if (type === "connection.status" && (run !== null || subject.kind !== "connection" || !subject.id))
    throw new Error("Connection status requires a connection subject without a run");
  if (type === "invalidate") return { type, subject, ...Invalidation.parse(payload) };
  if (type === "tombstone") return { type, subject, ...Tombstone.parse(payload) };
  if (type === "deadline") return { type, subject, scope: { kind: "collection", id: "all" }, ...Deadline.parse(payload) };
  const event = EmittedWorkspaceEvent.parse({ type, payload, subject, scope: eventScope(type, run, input) });
  if (event.type === "message.upsert") event.scope = { kind: "conversation", id: event.payload.message.conversation_id };
  else if (event.type === "message.remove")
    event.scope = { kind: "conversation", id: event.payload.conversationId };
  else if (event.type === "message.delta" && "conversationId" in event.payload)
    event.scope = { kind: "conversation", id: event.payload.conversationId };
  else if (event.type.startsWith("decision."))
    event.scope = { kind: "collection", id: "decisions" };
  if (new TextEncoder().encode(JSON.stringify(event)).length > 16 * 1024 * 1024)
    throw new Error("Workspace event exceeds its durable size bound");
  return event;
}
export function historicalEvent(row: {
  run_id: string | null;
  subject_kind?: string;
  subject_id?: string;
  type: string;
  payload: string | null;
}): WorkspaceEvent {
  const parsed = WorkspaceSubject.safeParse({ kind: row.subject_kind ?? (row.type === "connection.status" ? "connection" : "run"), id: row.subject_id ?? row.run_id });
  const subject = parsed.success ? parsed.data : undefined;
  if (row.payload === null) {
    const scope = WorkspaceScope.safeParse(eventScope(row.type, row.run_id, subject));
    return Object.hasOwn(Payloads, row.type) && scope.success
      ? invalidate(scope.data, subject?.kind === "message" ? subject : undefined) : invalidate();
  }
  try {
    return parseEmission(row.run_id, row.type, JSON.parse(row.payload), subject);
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
export const COMPLETE_WORKSPACE_CAPABILITIES: WorkspaceCapabilities = {
  ...PARTIAL_WORKSPACE_CAPABILITIES, invalidations: "complete", deadlines: true,
  transcript: "delta",
  feed: "delta", results: "delta",
};
export const WorkspaceClock = z.strictObject({
  epoch: z.string().min(1).max(200),
  serverNow: Count, nextDeadline: Count.nullable(), cursor: Count,
});
export type WorkspaceClock = z.infer<typeof WorkspaceClock>;
// The tolerant decoder has the same canonical output union as stored events.
export const WorkspaceEventDecoder = z.unknown().transform(parseWorkspaceEvent);
export const WorkspaceFrameV3 = z.discriminatedUnion("type", [
  z.strictObject({
    v: z.literal(3),
    type: z.literal("reset"),
    epoch: z.string().min(1).max(200),
    cursor: Count,
    build: z.string().max(1000),
    buildIdentity: z.unknown(),
    capabilities: WorkspaceCapabilities,
    // Optional while talking to older v3 sources with partial coverage.
    serverNow: Count.optional(),
    nextDeadline: Count.nullable().optional(),
  }),
  z.strictObject({
    v: z.literal(3),
    type: z.literal("events"),
    capabilities: WorkspaceCapabilities.optional(),
    epoch: z.string().min(1).max(200),
    cursor: Count,
    events: z
      .array(
        z.strictObject({
          id: Count,
          event: WorkspaceEventDecoder,
        }),
      )
      .min(1)
      .max(110),
  }),
]);
export type WorkspaceFrameV3 = z.infer<typeof WorkspaceFrameV3>;
