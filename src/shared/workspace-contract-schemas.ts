import {
  AgentId,
  ConnectionId,
  ConversationId,
  FolderId,
  MessageId,
  OwnerId,
  ProjectId,
  RunId,
  TeamId,
} from "./contract-ids.js";
import { PublicArtifact } from "./artifact-contract-schema.js";
import { PublicRun } from "./run-contract-schema.js";
export { PublicArtifact, PublicRun };
import { FeedEntities } from "./feed-projection.js";
import { SteeringReplyContext } from "./steering-replies.js";
import { z } from "zod";
import { ProviderSchema as Provider } from "./provider-schema.js";
import { DoneDisplaySchema, FeedRunSchema } from "./done-card.js";
import { WorkspaceClock } from "./workspace-events.js";
import { ProjectedMessage } from "./transcript-projection.js";
import { CardTokenSchema } from "./card-token-schemas.js";
import { Text, MaybeText, Time } from "./route-contract.js";
import { RunDisplayState } from "./run-state.js";
import { MessageRole } from "./message-roles.js";
import { AgentOrigin, ConversationOrigin } from "./origins.js";
import { ConnectionStatus } from "./connection-status.js";
import { Approval } from "./approval-contract-schema.js";
export { Approval };
import { NativeDecisionState } from "./native-decision-state.js";

// Owner-session HTTP projections. Never import a storage row or credential schema here.

export const PublicAgent = z.object({
  id: AgentId,
  owner_id: OwnerId,
  name: Text,
  normalized_name: Text.optional(),
  provider: Provider,
  connection_id: ConnectionId.nullable(),
  model: Text,
  effort: MaybeText.optional(),
  instructions: Text,
  folder_id: FolderId.nullable().optional(),
  origin: AgentOrigin,
  retired_at: Time.nullable().optional(),
  created_at: Time,
});
export const PublicConnection = z.object({
  id: ConnectionId,
  provider: Provider,
  label: Text,
  status: ConnectionStatus,
  models: Text,
  metadata: Text,
});
export const PublicFolder = z.object({
  id: FolderId,
  owner_id: OwnerId.optional(),
  name: Text,
  parent_id: FolderId.nullable(),
  kind: z.enum(["folder", "project"]),
  created_at: Time.optional(),
  path: MaybeText.optional(),
  is_workspace: z.union([z.boolean(), z.number()]).optional(),
});
export const PublicTeam = z.object({
  id: TeamId,
  owner_id: OwnerId.optional(),
  name: Text,
  manager_id: AgentId,
  conversation_id: ConversationId.nullable(),
  members: z.array(AgentId),
  created_at: Time.optional(),
  deleted_at: Time.nullable().optional(),
  preset_id: MaybeText.optional(),
  preset_version: z.number().nullable().optional(),
  preset_config: MaybeText.optional(),
  folder_id: FolderId.nullable().optional(),
  hide_results_from_feed: z.number().optional(),
  // Message threads between its agents that hit a limit and await Resume.
  paused_threads: z.number().optional(),
});
export const PublicMessage = z.object({
  id: MessageId,
  owner_id: OwnerId,
  conversation_id: ConversationId,
  run_id: RunId.nullable(),
  role: MessageRole,
  content: Text,
  metadata: Text,
  created_at: Time,
  revision: z.number().optional(),
  update_key: MaybeText.optional(),
  transcript_ordinal: z.number().nullable().optional(),
  run_state: RunDisplayState.nullable().optional(),
  run_error: MaybeText.optional(),
  /** JSON checkout summary Loop observed for the run, when it has one. */
  run_checkout: MaybeText.optional(),
  /** JSON list of verification commands Loop observed for the run. */
  run_verification: MaybeText.optional(),
});
export const PublicConversation = z.object({
  id: ConversationId,
  owner_id: OwnerId,
  agent_id: AgentId.nullable(),
  title: Text,
  origin: ConversationOrigin,
  external_id: MaybeText,
  created_at: Time,
  team_id: TeamId.nullable(),
  execution_connection_id: ConnectionId.nullable(),
  project_id: ProjectId.nullable(),
  feed_hidden: z.number(),
});
export const Bootstrap = z.object({
  agents: z.array(PublicAgent),
  connections: z.array(PublicConnection),
  folders: z.array(PublicFolder),
  teams: z.array(PublicTeam),
  environmentName: Text,
  preview: z
    .object({
      name: Text,
      mode: z.enum(["design", "working"]),
      build: z.object({
        id: Text,
        branch: Text,
        commit: Text,
        dirty: z.boolean(),
        builtAt: Text,
        sourceHash: Text,
        artifactHash: Text,
      }),
    })
    .optional(),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

export const FeedItem = DoneDisplaySchema.extend({
  reply_card_key: Text.optional(),
  reply: SteeringReplyContext.optional(),
  // Reply cards do not include pull-watch state.
  pull: DoneDisplaySchema.shape.pull.optional(),
  last_activity_at: Time,
  last_message: DoneDisplaySchema.shape.last_message
    .unwrap()
    .extend({
      created_at: Time,
      content: Text.optional(),
      saved: z.boolean().optional(),
    })
    .nullable(),
  run: FeedRunSchema.nullable(),
  done_card_key: Text.optional(),
  position_message_id: MaybeText,
  later: DoneDisplaySchema.shape.later
    .unwrap()
    .extend({
      condition: MaybeText,
      due_at: Time.nullable(),
      surfaced_at: Time.nullable(),
    })
    .nullable(),
  queued_runs: z
    .array(
      z.object({
        id: Text,
        input: Text,
        created_at: Time,
        queue_position: z.number().nullable(),
        can_edit: z.boolean(),
        can_move_up: z.boolean(),
        can_move_down: z.boolean(),
      }),
    )
    .optional(),
  live_preview: MaybeText.optional(),
  pending_approvals: z.number(),
  next_action: z
    .object({
      kind: z.enum(["approve", "answer", "result"]),
      message_id: MaybeText,
      run_id: Text,
      ref: Text.optional(),
    })
    .nullable()
    .optional(),
});
export const FeedPage = z.object({
  items: z.array(FeedItem),
  next: MaybeText,
  summary: z.object({
    needs: z.number(),
    working: z.number(),
    queued: z.number(),
    later_due: z.number(),
    replies_unread: z.number().optional(),
    done_unread: z.number().optional(),
    social_unread: z.number().optional(),
    scheduled_failed: z.number().optional(),
    scheduled_pending: z.number().optional(),
  }),
  projection: WorkspaceClock.optional(),
  projectionRows: FeedEntities.optional(),
});
export type FeedPage = z.infer<typeof FeedPage>;
export const ConversationPage = z.object({
  conversation: PublicConversation,
  working: z.boolean(),
  messages: z.array(
    PublicMessage.extend({ cursor: ProjectedMessage.shape.cursor }),
  ),
  next: MaybeText,
  range: z.object({
    from: ProjectedMessage.shape.cursor,
    before: ProjectedMessage.shape.cursor,
  }),
  position_message_id: MaybeText,
  saved: z.array(Text),
  steerable_run_id: MaybeText,
  resumed: z.boolean(),
  projection: WorkspaceClock.optional(),
  // The agent's latest visible message, beyond this page if need be.
  latest_agent_message: z
    .object({ id: Text, cursor: ProjectedMessage.shape.cursor })
    .nullable(),
});
export type ConversationPage = z.infer<typeof ConversationPage>;
const ResultFields = {
  cursor: z.number(),
  agent_id: MaybeText,
  team_id: MaybeText,
  name: MaybeText,
  provider: Provider.nullable(),
  folder_id: MaybeText.optional(),
};
export const ResultItem = z.union([
  PublicArtifact.extend(ResultFields),
  PublicMessage.extend(ResultFields),
]);
export type ResultItem = z.infer<typeof ResultItem>;
export const ResultsPage = z.object({
  items: z.array(ResultItem),
  next: z.number().nullable(),
  revision: z.number(),
  projection: WorkspaceClock.optional(),
});
export const ResultsUpdates = z.object({
  items: z.array(ResultItem),
  removed: z.array(Text),
  revision: z.number(),
  more: z.boolean(),
  projection: WorkspaceClock.optional(),
});
export const NativeDecision = z.object({
  id: Text,
  run_id: Text,
  conversation_id: Text,
  generation: Text,
  native_id: Text,
  request: Text,
  state: NativeDecisionState,
  command_id: MaybeText,
  digest: MaybeText,
  created_at: Time,
  name: MaybeText,
  provider: Provider.nullable(),
  input: Text,
});
export type NativeDecision = z.infer<typeof NativeDecision>;

export const CardErrorSchema = z.object({ error: z.string() });
export const CreatedCardTokenSchema = z.object({
  token: CardTokenSchema,
  secret: z.string(),
});

export const Teams = Text.max(2000).optional();

export const ResultSelection = {
  agent: Text.optional(),
  folder: Text.optional(),
  teams: Teams,
  view: z.enum(["all", "prompts", "files"]).default("all"),
  saved: z.enum(["1", "0"]).optional(),
};
