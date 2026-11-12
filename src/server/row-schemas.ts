import type { ArtifactRole } from "../shared/artifact-role.js";
import {
  RowId as Id,
  RunRecord,
  Provider,
  ConnectionRecord,
  MessageRecord,
  ArtifactRecord,
  McpConnectionRecord,
} from "./sql/rows.js";
export {
  AgentRecord,
  ConnectionRecord,
  ConversationRecord,
  MessageRecord,
  ArtifactRecord,
  ObjectRecord,
  FolderRecord,
  ImportRecord,
  McpConnectionRecord,
  ApprovalRecord,
  OperationRecord,
  TeamRecord,
  MemorySourceRecord,
} from "./sql/rows.js";
import { z } from "zod";
import { Billing, Harness } from "../shared/protocol.js";
import { PERMISSION_MODES } from "../shared/permission-modes.js";
import { Problem } from "../shared/problem.js";

const PermissionMode = z.enum(PERMISSION_MODES.map((mode) => mode.value));
const Reply = z.strictObject({
  id: Id,
  content: z.string(),
  name: z.string(),
  created_at: z.number(),
  mine: z.boolean().optional(),
  excerpt: z.boolean().optional(),
});
const Source = z.strictObject({
  url: z.string(),
  title: z.string(),
  excerpt: z.string(),
});
const UploadedFile = z.strictObject({
  id: Id,
  objectId: Id,
  name: z.string(),
  mime: z.string(),
  size: z.number().nonnegative(),
  published: z.boolean().optional(),
});
export const AgentSnapshot = z.strictObject({
  agentId: Id,
  name: z.string(),
  provider: Provider,
  connectionId: Id,
  model: z.string().min(1),
  resolvedModel: z.string().optional(),
  effort: z.string().nullable().optional(),
  permissionMode: PermissionMode.optional(),
  instructions: z.string(),
  folderId: Id.nullable(),
  maxTokens: z.number().int().positive().optional(),
  maxSeconds: z.number().positive().optional(),
  source: Source.optional(),
  teamId: Id.optional(),
  reviewId: Id.optional(),
  attachmentIds: z.array(Id).optional(),
  mailId: Id.optional(),
  replyTo: Reply.optional(),
  previewFixture: z.boolean().optional(),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshot>;
// Queue infrastructure also carries import, MCP and diagnostic jobs.
// Present identity/permission fields are validated even before kind dispatch;
// each executor requires its complete payload before causing an external effect.
export const RunPayload = AgentSnapshot.partial().extend({
  importId: Id.optional(),
  tool: Id.optional(),
  arguments: z.record(z.string(), z.json()).optional(),
  idempotencyKey: Id.optional(),
});
export type RunPayload = z.infer<typeof RunPayload>;

export const MessageMetadata = RunPayload.extend({
  state: z.string().optional(),
  personal: z.boolean().optional(),
  preview: z.boolean().optional(),
  origin: z.string().optional(),
  externalId: z.string().optional(),
  parent: z.string().nullable().optional(),
  activeBranch: z.boolean().optional(),
  raw: z.json().optional(),
  sourceConversation: Id.optional(),
  sourceMessage: Id.optional(),
  selectedByUser: z.boolean().optional(),
  forked: z.boolean().optional(),
  original: z.record(z.string(), z.json()).optional(),
  partial: z.boolean().optional(),
  messageId: Id.optional(),
  usage: z.json().optional(),
  completedMessageId: Id.optional(),
  delivery: z.string().optional(),
  progress: z.boolean().optional(),
  final: z.boolean().optional(),
  native: z.union([z.boolean(), z.record(z.string(), z.json())]).optional(),
  finalNativeItemId: Id.optional(),
  itemId: Id.optional(),
  phase: z.string().optional(),
  round: z.number().optional(),
  replyTo: Reply.optional(),
  attachments: z.array(UploadedFile).optional(),
  source: Source.optional(),
  reply: z.strictObject({ to: Id, published: z.literal(true) }).optional(),
  automation: z.record(z.string(), z.json()).optional(),
  steeringId: Id.optional(),
  callId: Id.optional(),
  toolCalls: z.array(z.json()).optional(),
  name: z.string().optional(),
  agentMail: z.record(z.string(), z.json()).optional(),
  imported: z.boolean().optional(),
});
export type MessageMetadata = z.infer<typeof MessageMetadata>;

// D5: artifact metadata is one strict schema per role, and the role selects
// the arm at write and read. The `edited` stamp written by the owner edit
// route (markEdited) may appear on any role, so it is present in every arm.
export const AnswerArtifactMetadata = z.strictObject({
  ...AgentSnapshot.partial().shape,
  preview: z.boolean().optional(),
  messageId: Id.optional(),
  native: z.boolean().optional(),
  finalNativeItemId: Id.optional(),
  edited: z.boolean().optional(),
});
export const TraceArtifactMetadata = z.strictObject({
  native: z.boolean().optional(),
  messageId: Id.optional(),
  connectionId: Id.optional(),
  tool: Id.optional(),
  arguments: z.record(z.string(), z.json()).optional(),
  invocationId: Id.optional(),
  fetchedAt: z.number().optional(),
  toolResult: z.json().optional(),
  // Interactive-app tools carry their HTML here; the /app route and the card
  // display read it (no current producer emits other tool app resources).
  appResource: z.record(z.string(), z.json()).optional(),
  isError: z.boolean().optional(),
  fixture: z.boolean().optional(),
  edited: z.boolean().optional(),
});
export const FileArtifactMetadata = z.strictObject({
  uploaded: z.boolean().optional(),
  name: z.string().optional(),
  mime: z.string().optional(),
  size: z.number().nonnegative().optional(),
  checksum: z.string().optional(),
  text: z.boolean().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  edited: z.boolean().optional(),
});
export const UploadArtifactMetadata = z.strictObject({
  upload: z.boolean().optional(),
  objectId: Id.optional(),
  mime: z.string().optional(),
  size: z.number().nonnegative().optional(),
  text: z.boolean().optional(),
  edited: z.boolean().optional(),
});
export const ImportArtifactMetadata = z.strictObject({
  origin: z.string().optional(),
  provider: z.string().optional(),
  importId: Id.optional(),
  externalId: z.string().optional(),
  rawObjectId: Id.optional(),
  objectId: Id.optional(),
  edited: z.boolean().optional(),
});
export const SnippetArtifactMetadata = z.strictObject({
  snippet: z.boolean().optional(),
  edited: z.boolean().optional(),
});

export const ArtifactMetadataSchemas = {
  answer: AnswerArtifactMetadata,
  trace: TraceArtifactMetadata,
  file: FileArtifactMetadata,
  upload: UploadArtifactMetadata,
  import: ImportArtifactMetadata,
  snippet: SnippetArtifactMetadata,
} as const;
// The read-side consumer type: every optional field some arm declares. The
// strict per-role schemas above are the runtime validators; this flat type is
// only for callers that read a field whose arm varies by row.
export type ArtifactMetadata = Partial<{
  agentId: string;
  name: string;
  provider: string;
  connectionId: string;
  model: string;
  resolvedModel: string;
  effort: string | null;
  permissionMode: string;
  instructions: string;
  folderId: string | null;
  maxTokens: number;
  maxSeconds: number;
  source: unknown;
  teamId: string;
  reviewId: string;
  attachmentIds: string[];
  mailId: string;
  replyTo: unknown;
  previewFixture: boolean;
  preview: boolean;
  messageId: string;
  native: boolean;
  finalNativeItemId: string;
  edited: boolean;
  tool: string;
  arguments: Record<string, unknown>;
  invocationId: string;
  fetchedAt: number;
  toolResult: unknown;
  appResource: Record<string, unknown>;
  isError: boolean;
  fixture: boolean;
  uploaded: boolean;
  mime: string;
  size: number;
  checksum: string;
  text: boolean;
  upload: boolean;
  objectId: string;
  origin: string;
  importId: string;
  externalId: string;
  rawObjectId: string;
  snippet: boolean;
}>;
export function parseArtifactMetadata(role: ArtifactRole, value: unknown) {
  return ArtifactMetadataSchemas[role].parse(value);
}
export const ConnectionMetadata = z.strictObject({
  preview: z.boolean().optional(),
  loopHarness: Harness.optional(),
  authMode: z.enum(["subscription", "native-existing", "api-key"]).optional(),
  runtimeKind: z.literal("loop-local").optional(),
  permissionMode: PermissionMode.optional(),
  location: z.string().optional(),
  environmentName: z.string().optional(),
  scope: z.string().optional(),
  plan: z.json().optional(),
  limits: z.json().optional(),
  checkedAt: z.number().optional(),
  billing: z.union([z.string(), Billing]).optional(),
  capabilities: z.record(z.string(), z.json()).optional(),
});
export type ConnectionMetadata = z.infer<typeof ConnectionMetadata>;
export const ConnectionModels = z.array(
  z.strictObject({
    id: Id,
    name: z.string(),
    capabilities: z.string().optional(),
    resolvedModel: z.string().optional(),
    effortLevels: z
      .array(z.strictObject({ value: Id, description: z.string().optional() }))
      .optional(),
    defaultEffort: z.string().optional(),
  }),
);
export type ConnectionModels = z.infer<typeof ConnectionModels>;
export const SealedEnvelope = z.string().refine((value) => {
  const parts = value.split(".");
  return (
    parts.length === 3 &&
    parts.every((part) =>
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        part,
      ),
    ) &&
    Buffer.from(parts[0], "base64").length === 12 &&
    Buffer.from(parts[1], "base64").length === 16
  );
}, "Invalid sealed envelope");

export class InvalidRow extends Problem {
  constructor(
    public table: string,
    public rowId: string,
    public column: string,
  ) {
    super(
      409,
      `Saved ${table} record ${rowId} is unavailable: invalid ${column}.`,
      { table, rowId, column },
    );
  }
}
export function readJson<T extends z.ZodType>(
  schema: T,
  value: unknown,
  table: string,
  rowId: string,
  column: string,
): z.output<T> {
  try {
    return schema.parse(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    throw new InvalidRow(table, rowId, column);
  }
}
export function parseRecord<T extends z.ZodType>(
  schema: T,
  value: unknown,
  table: string,
): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const identity = z.object({ id: z.string() }).safeParse(value);
  throw new InvalidRow(
    table,
    identity.success ? identity.data.id : "<missing id>",
    "row",
  );
}
const RunRow = RunRecord.extend({ payload: RunPayload });
export type Run = z.infer<typeof RunRow>;
// Stopping or dismissing a record must not make its execution payload readable
// or executable. Control paths use only these owner-checked scalar fields.
export const RunControl = RunRow.pick({
  id: true,
  owner_id: true,
  state: true,
  worker_id: true,
  attention_dismissed_at: true,
});
// Notification delivery reads the stopped sender's outcome, never its execution
// payload. The recipient still builds and validates its own fresh run.
export const RunNotice = RunRow.pick({
  id: true,
  owner_id: true,
  agent_id: true,
  conversation_id: true,
  input: true,
  state: true,
  result: true,
  error: true,
});
export type RunNotice = z.infer<typeof RunNotice>;
export function maybeRunNotice(value: unknown) {
  return value === undefined
    ? undefined
    : parseRecord(RunNotice, value, "runs");
}
export function parseRun(value: unknown): Run {
  const raw = parseRecord(
    RunRecord.pick({ id: true, payload: true }),
    value,
    "runs",
  );
  const payload = readJson(RunPayload, raw.payload, "runs", raw.id, "payload");
  const result = RunRow.safeParse({ ...Object(value), payload });
  if (!result.success) throw new InvalidRow("runs", raw.id, "row");
  return result.data;
}
export function maybeRun(value: unknown) {
  return value === undefined ? undefined : parseRun(value);
}
export function parseRuns(values: unknown[]): Run[] {
  return values.map(parseRun);
}
// HTTP keeps the serialized public payload while execution readers migrate.
export function runResponse<T extends { payload: string | Run["payload"] }>(
  run: T,
): Omit<T, "payload"> & { payload: string } {
  return {
    ...run,
    payload:
      typeof run.payload === "string"
        ? run.payload
        : JSON.stringify(run.payload),
  };
}

const modelRead = ConnectionModels.element
  .extend({ name: z.string().optional() })
  .transform((model) => ({ ...model, name: model.name ?? model.id }));
export function parseConnection(value: unknown) {
  const row = parseRecord(ConnectionRecord, value, "connections");
  const metadata = readJson(
    ConnectionMetadata.passthrough(),
    row.metadata,
    "connections",
    row.id,
    "metadata",
  );
  const models = readJson(
    z.array(modelRead),
    row.models,
    "connections",
    row.id,
    "models",
  );
  // Empty is the existing "no credential" marker (native, subscription and
  // disconnected rows). It never authorizes provider-key execution.
  if (row.secret !== "" && !SealedEnvelope.safeParse(row.secret).success)
    throw new InvalidRow("connections", row.id, "secret");
  return { ...row, metadata, models };
}
export type Connection = ReturnType<typeof parseConnection>;
// Revocation needs the destination, never model catalogs, display fields or
// the provider credential being revoked. It cannot construct an execution row.
const ConnectionControlMetadata = ConnectionMetadata.pick({
  loopHarness: true,
  authMode: true,
  runtimeKind: true,
  permissionMode: true,
}).strip();
export function parseConnectionControl(value: unknown) {
  const row = parseRecord(
    ConnectionRecord.pick({
      id: true,
      owner_id: true,
      provider: true,
      metadata: true,
    }),
    value,
    "connections",
  );
  return {
    ...row,
    metadata: readJson(
      ConnectionControlMetadata,
      row.metadata,
      "connections",
      row.id,
      "metadata",
    ),
  };
}
export function parseMessage(value: unknown) {
  const row = parseRecord(MessageRecord, value, "messages");
  return {
    ...row,
    metadata: readJson(
      MessageMetadata.passthrough(),
      row.metadata,
      "messages",
      row.id,
      "metadata",
    ),
  };
}
export type Message = ReturnType<typeof parseMessage>;
export function parseArtifact(value: unknown) {
  const row = parseRecord(ArtifactRecord, value, "artifacts");
  return {
    ...row,
    // D5: stored JSON is parsed against the strict arm of the row's role;
    // the consumer-facing type stays the flat set of optional arm fields.
    metadata: readJson(
      ArtifactMetadataSchemas[row.role],
      row.metadata,
      "artifacts",
      row.id,
      "metadata",
    ) as ArtifactMetadata,
  };
}
export type Artifact = ReturnType<typeof parseArtifact>;

export function maybeConnection(value: unknown) {
  return value === undefined ? undefined : parseConnection(value);
}

export function parseMessages(values: unknown[]) {
  return values.map(parseMessage);
}

export function agentPayload(run: Run) {
  return readJson(
    AgentSnapshot.strip(),
    run.payload,
    "runs",
    run.id,
    "payload",
  );
}

export function requireSealedSecret(connection: Connection) {
  if (!SealedEnvelope.safeParse(connection.secret).success)
    throw new InvalidRow("connections", connection.id, "secret");
  return connection.secret;
}

export function messageResponse<T extends Message>(row: T) {
  return { ...row, metadata: JSON.stringify(row.metadata) };
}
export function artifactResponse<T extends Artifact>(row: T) {
  return { ...row, metadata: JSON.stringify(row.metadata) };
}

// A fresh turn carries only these separately validated fields from its
// predecessor. Unrelated corrupt execution fields never become defaults.
export function readRunFolder(value: unknown, rowId: string) {
  return readJson(
    RunPayload.pick({ folderId: true }).strip(),
    value,
    "runs",
    rowId,
    "payload",
  ).folderId;
}
export function readRunReviewId(value: unknown, rowId: string) {
  return readJson(
    RunPayload.pick({ reviewId: true }).strip(),
    value,
    "runs",
    rowId,
    "payload",
  ).reviewId;
}
export function readRunConnectionId(value: unknown, rowId: string) {
  return readJson(
    RunPayload.pick({ connectionId: true }).strip(),
    value,
    "runs",
    rowId,
    "payload",
  ).connectionId;
}

export function parseMcpConnection(value: unknown) {
  const row = parseRecord(McpConnectionRecord, value, "mcp_connections");
  if (row.secret !== "" && !SealedEnvelope.safeParse(row.secret).success)
    throw new InvalidRow("mcp_connections", row.id, "secret");
  return row;
}
