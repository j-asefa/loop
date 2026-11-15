import { z } from "zod";

// Version 2 seals `provenance.origin`. Version 1 records predate it and keep
// their original digest serialization.
export const RESULT_SCHEMA_VERSION = 2 as const;
export const ResultSchemaVersionSchema = z.union([z.literal(1), z.literal(2)]);
export type ResultSchemaVersion = z.infer<typeof ResultSchemaVersionSchema>;

export const ResultIdSchema = z
  .string()
  .regex(/^(?:run|reply|message):[^\s/]{1,160}$/);
export type ResultId = z.infer<typeof ResultIdSchema>;

export const ResultKindSchema = z.enum([
  "run_answer",
  "steering_reply",
  "imported_answer",
]);
export type ResultKind = z.infer<typeof ResultKindSchema>;

export const ResultOriginCompletenessSchema = z.enum([
  "sealed_at_publication",
  "migrated_backfill",
]);
export type ResultOriginCompleteness = z.infer<
  typeof ResultOriginCompletenessSchema
>;

export const RequestedResultContextSchema = z.object({
  resultId: ResultIdSchema,
  excerpt: z.string().min(1).max(2_400).optional(),
});
export type RequestedResultContext = z.infer<
  typeof RequestedResultContextSchema
>;

export const ResultSupplyItemSchema = z.object({
  resultId: ResultIdSchema,
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string(),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  conversationId: z.string(),
  suppliedText: z.string(),
  excerpt: z.boolean(),
  truncated: z.boolean(),
});
export type ResultSupplyItem = z.infer<typeof ResultSupplyItemSchema>;

export const ResultAttachmentRefSchema = z.object({
  artifactId: z.string(),
  objectId: z.string().nullable(),
  version: z.number().int().positive(),
  sha256: z.string().nullable(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  published: z.boolean(),
});
export type ResultAttachmentRef = z.infer<typeof ResultAttachmentRefSchema>;

export const ResultStimulusSchema = z.object({
  kind: z.enum([
    "user_prompt",
    "steering_question",
    "delegation",
    "schedule",
    "import",
    "system",
  ]),
  text: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  authorKind: z.enum(["owner", "agent", "system", "unknown"]),
  automationKind: z.string().nullable().default(null),
  automationFrom: z.string().nullable().default(null),
});
export type ResultStimulus = z.infer<typeof ResultStimulusSchema>;

export const ResultOutcomeSchema = z.object({
  title: z.string(),
  body: z.string(),
  format: z.literal("markdown"),
});
export type ResultOutcome = z.infer<typeof ResultOutcomeSchema>;

// Where the work was produced. Current organization stays mutable on the
// conversation; this snapshot keeps the placement at publication time.
// Findings recorded beside a sealed Result whose recorded facts disagree with
// retained evidence. The Result itself is never rewritten.
export const ResultDefectKindSchema = z.enum(["copy_attribution"]);
export type ResultDefectKind = z.infer<typeof ResultDefectKindSchema>;

export const ResultPlacementSchema = z.object({
  status: z.enum(["recorded", "unknown"]),
  folderId: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  teamId: z.string().nullable(),
});
export type ResultPlacement = z.infer<typeof ResultPlacementSchema>;
export const UNKNOWN_RESULT_PLACEMENT: ResultPlacement = {
  status: "unknown",
  folderId: null,
  projectId: null,
  projectName: null,
  teamId: null,
};

// How the published answer came to exist. A copy keeps its source author and
// names the original Result it was copied from; nested copies name the root
// original, not an intermediary. `unknown` records that no evidence of the
// answer's origin was available, rather than guessing one.
export const ResultOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("produced") }),
  z.object({
    kind: z.literal("external_import"),
    provider: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("copied"),
    // Null when the root original message never became a sealed Result.
    sourceResultId: ResultIdSchema.nullable(),
    sourceMessageId: z.string(),
    sourceConversationId: z.string().nullable(),
    // False when the copied-from message no longer exists, so its author is
    // unknown.
    sourceAvailable: z.boolean(),
  }),
  z.object({ kind: z.literal("unknown") }),
]);
export type ResultOrigin = z.infer<typeof ResultOriginSchema>;

export const ResultProvenanceSchema = z.object({
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  resolvedModel: z.string().nullable(),
  connectionId: z.string().nullable(),
  conversationId: z.string(),
  runId: z.string().nullable(),
  messageId: z.string(),
  placement: ResultPlacementSchema.default(UNKNOWN_RESULT_PLACEMENT),
  // Absent only on schema version 1 records, which did not record an origin.
  origin: ResultOriginSchema.optional(),
});
export type ResultProvenance = z.infer<typeof ResultProvenanceSchema>;

export const PublishResultProvenanceSchema = ResultProvenanceSchema.extend({
  origin: ResultOriginSchema,
});

export const ResultLineageSchema = z.object({
  parentResultId: ResultIdSchema.nullable(),
  triggerMessageId: z.string().nullable(),
  suppliedContext: z.array(ResultSupplyItemSchema),
});
export type ResultLineage = z.infer<typeof ResultLineageSchema>;

export const PublishResultInputSchema = z.object({
  id: ResultIdSchema,
  ownerId: z.string().min(1),
  kind: ResultKindSchema,
  createdAt: z.number().int().nonnegative(),
  stimulus: ResultStimulusSchema,
  outcome: ResultOutcomeSchema,
  attachments: z.array(ResultAttachmentRefSchema),
  provenance: PublishResultProvenanceSchema,
  lineage: ResultLineageSchema,
});
export type PublishResultInput = z.infer<typeof PublishResultInputSchema>;

export const CanonicalResultSchema = PublishResultInputSchema.extend({
  schemaVersion: ResultSchemaVersionSchema,
  provenance: ResultProvenanceSchema,
  originCompleteness: ResultOriginCompletenessSchema,
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).refine(
  (result) =>
    (result.schemaVersion === 2) === (result.provenance.origin !== undefined),
  { message: "Result origin must match its schema version" },
);
export type CanonicalResult = z.infer<typeof CanonicalResultSchema>;

export function runResultId(runId: string): ResultId {
  return ResultIdSchema.parse(`run:${runId}`);
}

export function replyResultId(messageId: string): ResultId {
  return ResultIdSchema.parse(`reply:${messageId}`);
}

export function messageResultId(messageId: string): ResultId {
  return ResultIdSchema.parse(`message:${messageId}`);
}

export function collapseResultTitle(
  text: string | null | undefined,
  fallback = "Result",
  max = 200,
): string {
  const collapsed = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return fallback;
  return collapsed.slice(0, max);
}

export type ResultDigestTarget = {
  id: string;
  kind: ResultKind;
  stimulus: ResultStimulus;
  outcome: ResultOutcome;
  attachments: ResultAttachmentRef[];
  provenance: ResultProvenance;
  lineage: ResultLineage;
};

// The schema version a record's facts belong to: origin was added in v2.
export function resultSchemaVersion(
  provenance: Pick<ResultProvenance, "origin">,
): ResultSchemaVersion {
  return provenance.origin === undefined ? 1 : 2;
}

function serializedOrigin(origin: ResultOrigin) {
  switch (origin.kind) {
    case "produced":
    case "unknown":
      return { kind: origin.kind };
    case "external_import":
      return { kind: origin.kind, provider: origin.provider };
    case "copied":
      return {
        kind: origin.kind,
        sourceResultId: origin.sourceResultId,
        sourceMessageId: origin.sourceMessageId,
        sourceConversationId: origin.sourceConversationId,
        sourceAvailable: origin.sourceAvailable,
      };
  }
}

export function canonicalResultDigestSerialized(
  input: ResultDigestTarget,
): string {
  const stimulus = ResultStimulusSchema.parse(input.stimulus);
  const outcome = ResultOutcomeSchema.parse(input.outcome);
  const attachments = z
    .array(ResultAttachmentRefSchema)
    .parse(input.attachments);
  const provenance = ResultProvenanceSchema.parse(input.provenance);
  const lineage = ResultLineageSchema.parse(input.lineage);
  const schemaVersion = resultSchemaVersion(provenance);
  return JSON.stringify({
    schemaVersion,
    id: input.id,
    kind: input.kind,
    stimulus: {
      kind: stimulus.kind,
      text: stimulus.text,
      sourceMessageId: stimulus.sourceMessageId,
      authorKind: stimulus.authorKind,
      automationKind: stimulus.automationKind ?? null,
      automationFrom: stimulus.automationFrom ?? null,
    },
    outcome: {
      title: outcome.title,
      body: outcome.body,
      format: outcome.format,
    },
    attachments: attachments.map((item) => ({
      artifactId: item.artifactId,
      objectId: item.objectId,
      version: item.version,
      sha256: item.sha256,
      name: item.name,
      mime: item.mime,
      size: item.size,
      published: item.published,
    })),
    provenance: {
      agentId: provenance.agentId,
      agentName: provenance.agentName,
      provider: provenance.provider,
      model: provenance.model,
      resolvedModel: provenance.resolvedModel,
      connectionId: provenance.connectionId,
      conversationId: provenance.conversationId,
      runId: provenance.runId,
      messageId: provenance.messageId,
      placement: {
        status: provenance.placement.status,
        folderId: provenance.placement.folderId,
        projectId: provenance.placement.projectId,
        projectName: provenance.placement.projectName,
        teamId: provenance.placement.teamId,
      },
      // Version 1 serialization is unchanged, so its digests still verify.
      ...(provenance.origin === undefined
        ? {}
        : { origin: serializedOrigin(provenance.origin) }),
    },
    lineage: {
      parentResultId: lineage.parentResultId,
      triggerMessageId: lineage.triggerMessageId,
      suppliedContext: lineage.suppliedContext.map((item) => ({
        resultId: item.resultId,
        contentDigest: item.contentDigest,
        title: item.title,
        agentId: item.agentId,
        agentName: item.agentName,
        conversationId: item.conversationId,
        suppliedText: item.suppliedText,
        excerpt: item.excerpt,
        truncated: item.truncated,
      })),
    },
  });
}
