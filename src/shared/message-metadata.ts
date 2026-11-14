import { z } from "zod";
import { RunPayload } from "./run-payload.js";
import { Reply, Source, UploadedFile } from "./agent-snapshot.js";
import { ItemSchema } from "./protocol.js";
const Id = z.string().min(1);

export const MessageMetadata = RunPayload.extend({
  // No current message writer or audited row sets state (tool state is in traces).
  state: z.never().optional(),
  personal: z.boolean().optional(),
  preview: z.boolean().optional(),
  // native is retained for audited historical HAPI messages; current imports use import.
  origin: z.enum(["import", "native"]).optional(),
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
  completedMessageId: Id.nullable().optional(),
  delivery: z
    .enum(["pending", "sending", "delivered", "failed"])
    .nullable()
    .optional(),
  deliveryError: z.string().nullable().optional(),
  progress: z.boolean().optional(),
  final: z.boolean().optional(),
  native: z.union([z.boolean(), z.record(z.string(), z.json())]).optional(),
  finalNativeItemId: Id.optional(),
  itemId: Id.optional(),
  phase: ItemSchema.shape.phase,
  round: z.number().optional(),
  replyTo: Reply.optional(),
  attachments: z.array(UploadedFile).optional(),
  source: Source.optional(),
  reply: z.strictObject({ to: Id, published: z.literal(true) }).optional(),
  automation: z
    .object({
      kind: z
        .enum([
          "review_continuation",
          "github_watch",
          "feed_digest",
          "agent_message",
          "agent_result",
        ])
        .optional(),
      reviewId: Id.optional(),
      watchId: Id.optional(),
      digestId: Id.optional(),
      mailId: Id.optional(),
      threadId: Id.optional(),
      fromAgentId: Id.optional(),
      fromName: z.string().optional(),
    })
    .catchall(z.json())
    .optional(),
  steeringId: Id.optional(),
  callId: Id.optional(),
  toolCalls: z.array(z.json()).optional(),
  name: z.string().optional(),
  agentMail: z.record(z.string(), z.json()).optional(),
  imported: z.boolean().optional(),
  migratedProjection: z.boolean().optional(),
});
export type MessageMetadata = z.infer<typeof MessageMetadata>;

// Reads retain unknown historical keys exactly as the server's previous
// passthrough schema did. New writes still reject undeclared top-level fields.
const savedMetadata = MessageMetadata.passthrough();
export type SavedMessageMetadata = z.infer<typeof savedMetadata>;
export function readMessageMetadata(
  value: unknown,
  failure: "throw" | "fallback" = "throw",
): SavedMessageMetadata {
  try {
    return savedMetadata.parse(
      typeof value === "string" ? JSON.parse(value) : value,
    );
  } catch (error) {
    if (failure === "throw") throw error;
    return {};
  }
}
export function writeMessageMetadata(value: MessageMetadata): string;
export function writeMessageMetadata(
  value: SavedMessageMetadata,
  mode: "preserve",
): string;
export function writeMessageMetadata(
  value: MessageMetadata | SavedMessageMetadata,
  mode?: "preserve",
): string {
  // Re-serializing a read row for HTTP must retain its historical extra keys.
  return JSON.stringify(
    (mode === "preserve" ? savedMetadata : MessageMetadata).parse(value),
  );
}
