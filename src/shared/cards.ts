import {
  ArtifactId,
  MessageId,
  ConversationId,
  RunId,
  AgentId,
  FolderId,
  ProjectId,
  TeamId,
  requestId,
} from "./contract-ids.js";
import { z } from "zod";
import { DoneDisplaySchema } from "./done-card.js";
import { ArtifactKindSchema } from "./artifact-kind.js";
import { ArtifactRoleSchema } from "./artifact-role.js";
import { MessageRole } from "./message-roles.js";

const CardViewSchema = z.enum(["results", "saved", "sent", "done"]);
export const CardIdSchema = z
  .string()
  .regex(/^[amd]:[^/\\?#\s]+$/)
  .max(160);
const nullableText = z.string().nullable();
const time = z.number().int().nonnegative();
const CardAgentSchema = z.object({
  id: nullableText,
  name: nullableText,
  provider: nullableText,
});
const CardAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().nonnegative(),
  // Descriptive fields are the message's stored snapshot. Links are relative
  // to this API source and require ordinary browser authorization to open.
  href: z.string(),
  download: nullableText,
});
const common = {
  id: CardIdSchema,
  source: z.object({
    artifact_id: ArtifactId.nullable(),
    message_id: MessageId.nullable(),
    conversation_id: ConversationId.nullable(),
    run_id: RunId.nullable(),
    // The source thread's agent target is separate from the message's author.
    agent_id: AgentId.nullable(),
  }),
  author: CardAgentSchema.extend({
    kind: z.enum(["owner", "agent", "system", "unknown"]),
  }),
  recipient: CardAgentSchema.nullable(),
  context: z.object({
    conversation_title: nullableText,
    folder_id: FolderId.nullable(),
    project_id: ProjectId.nullable(),
    project_name: nullableText,
    team_id: TeamId.nullable(),
  }),
  content: z.string(),
  format: z.string(),
  // Lists and detail both contain the complete stored body.
  created_at: time,
  updated_at: time.nullable(),
  saved: z.boolean(),
  attachments: z.array(CardAttachmentSchema),
  href: z.string(),
};
export const ResultCardSchema = z.object({
  ...common,
  type: z.literal("result"),
  title: z.string(),
  kind: ArtifactKindSchema,
  role: ArtifactRoleSchema,
  version: z.number().int().positive(),
  hidden: z.boolean(),
  display: z.object({
    model: nullableText,
    tool: nullableText,
    mime: nullableText,
    filename: nullableText,
    size: z.number().nonnegative().nullable(),
    text: z.boolean(),
    download: nullableText,
    source: z
      .object({ url: z.string(), title: nullableText, excerpt: nullableText })
      .nullable(),
    refreshable: z.boolean(),
    app: z.boolean(),
  }),
});
export const MessageCardSchema = z.object({
  ...common,
  type: z.literal("message"),
  role: MessageRole,
});
export const DoneCardSchema = z.object({
  ...common,
  type: z.literal("done"),
  display: DoneDisplaySchema,
});
export const CardSchema = z.discriminatedUnion("type", [
  ResultCardSchema,
  MessageCardSchema,
  DoneCardSchema,
]);
export const CardEntrySchema = z.object({
  card: CardSchema,
  order: z.tuple([time, z.string()]),
  saved: z.object({ at: time, label: nullableText }).nullable(),
});
// A watermark binds the revision to its owner, source database and selection.
// It is a cursor, not a credential or an artifact content version.
export const CardPageSchema = z.object({
  revision: z.string(),
  items: z.array(CardEntrySchema),
  next: z.string().nullable(),
});
export const CardChangesSchema = z.object({
  revision: z.string(),
  items: z.array(CardEntrySchema),
  removed: z.array(CardIdSchema),
  more: z.boolean(),
});
const integer = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const CardSelectionSchema = z.object({
  view: CardViewSchema.default("results"),
  project: requestId(ProjectId).min(1).max(150).optional(),
  agent: requestId(AgentId).min(1).max(150).optional(),
  teams: z.string().max(2000).optional(),
  read: z
    .enum(["read", "unread"])
    .optional()
    .describe(
      "Filter Done results by read status; omit to include all entries.",
    ),
  q: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe("Search is supported only for Saved and Sent; omit for Results."),
});
export const CardListQuerySchema = CardSelectionSchema.extend({
  before: z.string().min(1).max(1024).optional(),
  limit: integer.min(1).max(100).default(40),
}).strict();
export const CardChangesQuerySchema = CardSelectionSchema.extend({
  after: z.string().min(1).max(1024),
  through: integer.optional(),
}).strict();
export type Card = z.infer<typeof CardSchema>;
export type ResultCard = z.infer<typeof ResultCardSchema>;
export type MessageCard = z.infer<typeof MessageCardSchema>;
export type CardEntry = z.infer<typeof CardEntrySchema>;
export const compareCardOrder = (
  a: CardEntry["order"],
  b: CardEntry["order"],
) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
export type CardPage = z.infer<typeof CardPageSchema>;
export type CardChanges = z.infer<typeof CardChangesSchema>;
export type CardSelection = z.infer<typeof CardSelectionSchema>;
export type CardView = z.infer<typeof CardViewSchema>;
