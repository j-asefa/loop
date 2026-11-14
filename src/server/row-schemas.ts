import {
  RowId as Id,
  RunRecord,
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

import { Problem } from "../shared/problem.js";

import {
  PermissionMode,
  AgentSnapshot,
  Reply,
  Source,
  UploadedFile,
} from "../shared/agent-snapshot.js";
export { AgentSnapshot } from "../shared/agent-snapshot.js";
import {
  RunPayload,
  readRunPayload,
  writeRunPayload,
  type RunPayloadField,
} from "../shared/run-payload.js";
export { RunPayload } from "../shared/run-payload.js";
function savedRunPayload(
  value: unknown,
  rowId: string,
  field?: RunPayloadField,
) {
  try {
    return readRunPayload(value, "throw", field);
  } catch {
    throw new InvalidRow("runs", rowId, "payload");
  }
}

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

import {
  readArtifactMetadata,
  writeArtifactMetadata,
} from "../shared/artifact-metadata.js";
export {
  ArtifactMetadataSchemas,
  AnswerArtifactMetadata,
  TraceArtifactMetadata,
  FileArtifactMetadata,
  UploadArtifactMetadata,
  ImportArtifactMetadata,
  SnippetArtifactMetadata,
} from "../shared/artifact-metadata.js";

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
  const payload = savedRunPayload(raw.payload, raw.id);
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
        : writeRunPayload(run.payload),
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
  try {
    return { ...row, ...readArtifactMetadata(row.role, row.metadata) };
  } catch {
    throw new InvalidRow("artifacts", row.id, "metadata");
  }
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
  return { ...row, metadata: writeArtifactMetadata(row) };
}

// A fresh turn carries only these separately validated fields from its
// predecessor. Unrelated corrupt execution fields never become defaults.
export function readRunFolder(value: unknown, rowId: string) {
  return savedRunPayload(value, rowId, "folderId").folderId;
}
export function readRunReviewId(value: unknown, rowId: string) {
  return savedRunPayload(value, rowId, "reviewId").reviewId;
}
export function readRunConnectionId(value: unknown, rowId: string) {
  return savedRunPayload(value, rowId, "connectionId").connectionId;
}

export function parseMcpConnection(value: unknown) {
  const row = parseRecord(McpConnectionRecord, value, "mcp_connections");
  if (row.secret !== "" && !SealedEnvelope.safeParse(row.secret).success)
    throw new InvalidRow("mcp_connections", row.id, "secret");
  return row;
}
