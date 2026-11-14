import { z } from "zod";
import type { ArtifactRole } from "./artifact-role.js";
import { ProviderSchema } from "./provider-schema.js";
import { AgentSnapshot } from "./agent-snapshot.js";
const Id = z.string().min(1);
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
  provider: ProviderSchema.optional(),
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
  origin: z.literal("import").optional(),
  provider: z.enum(["openai", "anthropic"]).optional(),
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

export type ArtifactMetadata = {
  [R in ArtifactRole]: {
    role: R;
    metadata: z.output<(typeof ArtifactMetadataSchemas)[R]>;
  };
}[ArtifactRole];
export type ArtifactMetadataInput = {
  [R in ArtifactRole]: {
    role: R;
    metadata?: z.input<(typeof ArtifactMetadataSchemas)[R]>;
  };
}[ArtifactRole];
export type TraceMetadata = z.output<typeof TraceArtifactMetadata>;

/** The wire and stored value is JSON text; role stays in its existing column. */
export function readArtifactMetadata<R extends ArtifactRole>(
  role: R,
  value: string,
  failure: "throw" | "fallback" = "throw",
): Extract<ArtifactMetadata, { role: R }> {
  let metadata;
  try {
    metadata = ArtifactMetadataSchemas[role].parse(JSON.parse(value));
  } catch (error) {
    if (failure === "throw") throw error;
    metadata = {};
  }
  // The selected schema is indexed by this same role. This is the sole point
  // where the runtime selection is attached to its correlated static type.
  return { role, metadata } as Extract<ArtifactMetadata, { role: R }>;
}
export function writeArtifactMetadata(value: ArtifactMetadataInput): string {
  return JSON.stringify(
    ArtifactMetadataSchemas[value.role].parse(value.metadata ?? {}),
  );
}
export function artifactMessageId(value: ArtifactMetadata) {
  return value.role === "answer" || value.role === "trace"
    ? value.metadata.messageId
    : undefined;
}
/** Fields used by result cards and viewers, selected from their owning roles. */
export function artifactDisplayMetadata(value: ArtifactMetadata) {
  const answer = value.role === "answer" ? value.metadata : undefined;
  const trace = value.role === "trace" ? value.metadata : undefined;
  const file = value.role === "file" ? value.metadata : undefined;
  const upload = value.role === "upload" ? value.metadata : undefined;
  const imported = value.role === "import" ? value.metadata : undefined;
  return {
    messageId: artifactMessageId(value),
    name: answer?.name ?? file?.name,
    model: answer?.model ?? file?.model,
    resolvedModel: answer?.resolvedModel,
    provider: answer?.provider ?? file?.provider ?? imported?.provider,
    connectionId: answer?.connectionId ?? trace?.connectionId,
    mime: file?.mime ?? upload?.mime,
    size: file?.size ?? upload?.size,
    text: file?.text ?? upload?.text,
    objectId: upload?.objectId ?? imported?.objectId,
    rawObjectId: imported?.rawObjectId,
    origin: imported?.origin,
    source: answer?.source,
    attachmentIds: answer?.attachmentIds,
    tool: trace?.tool,
    arguments: trace?.arguments,
    appResource: trace?.appResource,
    refreshable: !!trace?.connectionId,
  };
}
