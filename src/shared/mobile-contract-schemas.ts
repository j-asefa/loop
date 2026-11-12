import { z } from "zod";
import { RunDisplayState } from "./run-state.js";
import { MessageRole } from "./message-roles.js";
import { ScheduledSendState } from "./scheduled-send-state.js";
import { AttachmentIds, MAX_MESSAGE_FILES } from "./uploads.js";
import { REPLY_EXCERPT_LIMIT } from "./replies.js";

const Text = z.string(),
  MaybeText = Text.nullable(),
  Time = z.number();
const Target = Text.min(1).max(150);
const FutureTime = Time.int().positive().max(Number.MAX_SAFE_INTEGER);
export const PositionInput = z.object({ positionMessageId: Target.nullable() });
export const FeedUpdateInput = z.object({
  hidden: z.boolean(),
  cardKey: Text.regex(/^(run|message):.+$/).max(200),
});
export const DoneReadInput = z.object({
  cardKey: FeedUpdateInput.shape.cardKey,
  // Missing versions can read original results, but never erase a later unread.
  unreadVersion: z.number().int().nonnegative().safe().optional(),
});
// A stale group snapshot and its latest local unread response can each contain
// up to 100 members. The server only acts on the group's current membership.
export const DoneReadVersions = z
  .record(
    Text.regex(/^d:(run|message):.+$/).max(202),
    z.number().int().nonnegative().safe(),
  )
  .refine((versions) => Object.keys(versions).length <= 200);
export const DoneReadResult = z.object({
  ok: z.boolean(),
  unreadVersions: DoneReadVersions.optional(),
});
export const SavedLabelInput = z.object({
  key: Text.regex(/^[ma]:/)
    .min(3)
    .max(160),
  label: Text.trim().max(40),
});
export const LaterInput = z.object({
  kind: z.enum(["conversation", "artifact", "message", "story"]),
  targetId: Target,
  condition: z.enum(["time", "run_finished", "project_open"]),
  dueAt: FutureTime.optional(),
  projectId: Target.optional(),
});
export const ScheduleInput = z
  .object({
    agentId: Target,
    conversationId: Target.optional(),
    folderId: Target.nullish(),
    input: Text.trim().min(1).max(30000),
    attachmentIds: AttachmentIds,
    replyToMessageId: Target.optional(),
    replyExcerpt: Text.trim().min(1).max(REPLY_EXCERPT_LIMIT).optional(),
    idempotencyKey: Text.min(8).max(150),
    sendAt: FutureTime,
  })
  .refine((d) => !d.replyExcerpt || d.replyToMessageId, {
    message: "Choose the message the excerpt comes from",
    path: ["replyExcerpt"],
  });
export const ScheduleUpdateInput = z.object({
  input: Text.trim().min(1).max(30000).optional(),
  sendAt: FutureTime.optional(),
});
export const RunReorderInput = z.object({
  direction: z.enum(["up", "down"]),
  idempotencyKey: Text.min(8).max(150).optional(),
});
export const QueuedRunInput = z.object({
  input: Text.trim().min(1).max(30000),
});
export const RunWithdrawInput = z.object({
  idempotencyKey: Text.min(8).max(150).optional(),
  draftAttachmentIds: z.array(Target).max(MAX_MESSAGE_FILES).default([]),
});
export const RunMoveInput = z.object({
  agentId: Target,
  idempotencyKey: Text.min(8).max(150),
});
export const ConversationForkInput = z.object({
  messageId: Target,
  agentId: Target.optional(),
});

export const PublicAwayItem = z.object({
  conversation_id: Text,
  title: Text,
  agent_name: MaybeText,
  run_id: Text,
  state: RunDisplayState,
  updated_at: Time,
});
export const PublicAway = z.object({
  completed: z.array(PublicAwayItem),
  needs: z.array(PublicAwayItem),
  failed: z.array(PublicAwayItem),
});
export const PublicSavedMessage = z.object({
  message_id: Text,
  conversation_id: Text,
  conversation_title: Text,
  role: MessageRole,
  content: Text,
  created_at: Time,
  agent_id: MaybeText,
  agent_name: MaybeText,
  provider: MaybeText,
  project_name: MaybeText,
  preview: Text,
});
const PublicOutlineItem = z.object({
  message_id: Text,
  kind: z.enum(["prompt", "result", "approval", "failure", "saved"]),
  preview: Text,
  created_at: Time,
  run_id: MaybeText,
});
const PublicThreadMatch = z.object({
  message_id: Text,
  kind: z.enum(["prompt", "response", "update", "result", "failure"]),
  saved: z.boolean(),
  preview: Text,
  created_at: Time,
});
// Search emits matches; the ordinary outline does not. Explicit absence keeps
// an invalid search response from falling back to a branch that strips matches.
export const PublicOutline = z.union([
  z.object({ items: z.array(z.never()), matches: z.array(PublicThreadMatch) }),
  z.object({
    items: z.array(PublicOutlineItem),
    matches: z.never().optional(),
  }),
]);
export const PublicLater = z.object({
  id: Text,
  owner_id: Text,
  kind: LaterInput.shape.kind,
  target_id: Text,
  condition: LaterInput.shape.condition,
  due_at: Time.nullable(),
  project_id: MaybeText,
  created_at: Time,
  surfaced_at: Time.nullable(),
  done_at: Time.nullable(),

  snoozes: z.number(),
});

export const PublicCreatedLater = PublicLater.extend({
  replaced: MaybeText,
});
export const PublicLaterView = PublicLater.extend({
  title: Text,
  preview: Text,
  content: Text,
  provider: MaybeText,
  conversation_id: MaybeText,
  message_id: MaybeText,
  agent_name: MaybeText,
  project_name: MaybeText,

  url: MaybeText,
});
export const PublicLaterList = z.object({
  due: z.array(PublicLaterView),
  upcoming: z.array(PublicLaterView),
});
// These descriptors come from stored uploads, not credentials or object bytes.
export const PublicUploadDescriptor = z.object({
  id: Text,
  objectId: Text,
  name: Text,
  mime: Text,
  size: z.number(),
});
export const PublicScheduledSend = z.object({
  id: Text,
  owner_id: Text,
  agent_id: Text,
  conversation_id: MaybeText,
  folder_id: MaybeText,
  folder_chosen: z.number(),
  input: Text,
  attachment_ids: Text,
  reply_to_message_id: MaybeText,

  reply_excerpt: MaybeText,
  idempotency_key: Text,
  send_at: Time,
  state: ScheduledSendState,
  run_id: MaybeText,
  error: MaybeText,
  created_at: Time,
});
const PublicScheduledView = PublicScheduledSend.extend({
  agent_name: MaybeText,
  provider: MaybeText,
  conversation_title: MaybeText,
  folder_name: MaybeText,

  attachments: z.array(PublicUploadDescriptor),
});
export const PublicScheduledList = z.object({
  items: z.array(PublicScheduledView),
  failed_next: MaybeText,
});
export const PublicWithdrawnDraft = z.object({
  input: Text,
  agent_id: MaybeText,
  conversation_id: MaybeText,
  attachment_ids: z.array(Text),
  attachments: z.array(PublicUploadDescriptor),
});
const Tokens = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});
export const PublicUsage = z.object({
  runs: z.record(Text, Tokens),
  total: Tokens,

  memory: z.array(Text),
});
export const PublicSnippets = z.object({
  items: z.array(
    z.object({ id: Text, title: Text, content: Text, created_at: Time }),
  ),
});
export const PublicProjectSummaries = z.object({
  items: z.array(
    z.object({
      id: Text,
      name: Text,
      agents: z.number(),
      last_activity_at: Time.nullable(),
      working: z.number(),
      needs: z.number(),
      latest_result: z
        .object({ id: Text, title: Text, created_at: Time })
        .nullable(),
    }),
  ),
});
