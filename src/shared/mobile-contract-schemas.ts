import {
  AgentId,
  ConversationId,
  FolderId,
  MessageId,
  ProjectId,
  requestId,
  OwnerId,
  RunId,
  ArtifactId,
  LaterItemId,
  ObjectId,
  ScheduledSendId,
} from "./contract-ids.js";
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
export const PositionInput = z.object({
  positionMessageId: requestId(MessageId).min(1).max(150).nullable(),
});
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
  projectId: requestId(ProjectId).min(1).max(150).optional(),
});
export const ScheduleInput = z
  .object({
    agentId: requestId(AgentId).min(1).max(150),
    conversationId: requestId(ConversationId).min(1).max(150).optional(),
    folderId: requestId(FolderId).min(1).max(150).nullish(),
    input: Text.trim().min(1).max(30000),
    attachmentIds: AttachmentIds,
    replyToMessageId: requestId(MessageId).min(1).max(150).optional(),
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
  agentId: requestId(AgentId).min(1).max(150),
  idempotencyKey: Text.min(8).max(150),
});
export const ConversationForkInput = z.object({
  messageId: requestId(MessageId).min(1).max(150),
  agentId: requestId(AgentId).min(1).max(150).optional(),
});

export const PublicAwayItem = z.object({
  conversation_id: ConversationId,
  title: Text,
  agent_name: MaybeText,
  run_id: RunId,
  state: RunDisplayState,
  updated_at: Time,
});
export const PublicAway = z.object({
  completed: z.array(PublicAwayItem),
  needs: z.array(PublicAwayItem),
  failed: z.array(PublicAwayItem),
});
export const PublicSavedMessage = z.object({
  message_id: MessageId,
  conversation_id: ConversationId,
  conversation_title: Text,
  role: MessageRole,
  content: Text,
  created_at: Time,
  agent_id: AgentId.nullable(),
  agent_name: MaybeText,
  provider: MaybeText,
  project_name: MaybeText,
  preview: Text,
});
const PublicOutlineItem = z.object({
  message_id: MessageId,
  kind: z.enum(["prompt", "result", "approval", "failure", "saved"]),
  preview: Text,
  created_at: Time,
  run_id: RunId.nullable(),
});
const PublicThreadMatch = z.object({
  message_id: MessageId,
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
  id: LaterItemId,
  owner_id: OwnerId,
  kind: LaterInput.shape.kind,
  target_id: Text,
  condition: LaterInput.shape.condition,
  due_at: Time.nullable(),
  project_id: ProjectId.nullable(),
  created_at: Time,
  surfaced_at: Time.nullable(),
  done_at: Time.nullable(),

  snoozes: z.number(),
});

export const PublicCreatedLater = PublicLater.extend({
  replaced: LaterItemId.nullable(),
});
export const PublicLaterView = PublicLater.extend({
  title: Text,
  preview: Text,
  content: Text,
  provider: MaybeText,
  conversation_id: ConversationId.nullable(),
  message_id: MessageId.nullable(),
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
  id: ArtifactId,
  objectId: ObjectId,
  name: Text,
  mime: Text,
  size: z.number(),
});
export const PublicScheduledSend = z.object({
  id: ScheduledSendId,
  owner_id: OwnerId,
  agent_id: AgentId,
  conversation_id: ConversationId.nullable(),
  folder_id: FolderId.nullable(),
  folder_chosen: z.number(),
  input: Text,
  attachment_ids: Text,
  reply_to_message_id: MessageId.nullable(),

  reply_excerpt: MaybeText,
  idempotency_key: Text,
  send_at: Time,
  state: ScheduledSendState,
  run_id: RunId.nullable(),
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
  agent_id: AgentId.nullable(),
  conversation_id: ConversationId.nullable(),
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
    z.object({ id: ArtifactId, title: Text, content: Text, created_at: Time }),
  ),
});
export const PublicProjectSummaries = z.object({
  items: z.array(
    z.object({
      id: ProjectId,
      name: Text,
      agents: z.number(),
      last_activity_at: Time.nullable(),
      working: z.number(),
      needs: z.number(),
      latest_result: z
        .object({ id: ArtifactId, title: Text, created_at: Time })
        .nullable(),
    }),
  ),
});
