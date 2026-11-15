import { z } from "zod";

export const RESULT_SCHEMA_VERSION = 1 as const;

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
});
export type ResultProvenance = z.infer<typeof ResultProvenanceSchema>;

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
  provenance: ResultProvenanceSchema,
  lineage: ResultLineageSchema,
});
export type PublishResultInput = z.infer<typeof PublishResultInputSchema>;

export const CanonicalResultSchema = PublishResultInputSchema.extend({
  schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  originCompleteness: ResultOriginCompletenessSchema,
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
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
  return JSON.stringify({
    schemaVersion: RESULT_SCHEMA_VERSION,
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
