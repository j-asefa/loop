import { FeedEntities } from "./feed-projection.js";
import { SteeringReplyContext } from "./steering-replies.js";
import { z } from "zod";
import { ProviderSchema as Provider } from "./provider-schema.js";
import { DoneDisplaySchema } from "./done-card.js";
import { WorkspaceClock } from "./workspace-events.js";
import { ProjectedMessage } from "./transcript-projection.js";
import { CardTokenSchema } from "./card-token-schemas.js";
import { Text, MaybeText, Time } from "./route-contract.js";
import { ArtifactKindSchema } from "./artifact-kind.js";
import { ArtifactRoleSchema } from "./artifact-role.js";
import { RunDisplayState, RunKind } from "./run-state.js";
import { MessageRole } from "./message-roles.js";
import { AgentOrigin, ConversationOrigin } from "./origins.js";
import { ConnectionStatus } from "./connection-status.js";

// Owner-session HTTP projections. Never import a storage row or credential schema here.

export const PublicAgent = z.object({
  id: Text,
  owner_id: Text,
  name: Text,
  normalized_name: Text.optional(),
  provider: Provider,
  connection_id: MaybeText,
  model: Text,
  effort: MaybeText.optional(),
  instructions: Text,
  folder_id: MaybeText.optional(),
  origin: AgentOrigin,
  retired_at: Time.nullable().optional(),
  created_at: Time,
});
export const PublicConnection = z.object({
  id: Text,
  provider: Provider,
  label: Text,
  status: ConnectionStatus,
  models: Text,
  metadata: Text,
});
export const PublicFolder = z.object({
  id: Text,
  owner_id: Text.optional(),
  name: Text,
  parent_id: MaybeText,
  kind: z.enum(["folder", "project"]),
  created_at: Time.optional(),
  path: MaybeText.optional(),
  is_workspace: z.union([z.boolean(), z.number()]).optional(),
});
export const PublicTeam = z.object({
  id: Text,
  owner_id: Text.optional(),
  name: Text,
  manager_id: Text,
  conversation_id: MaybeText,
  members: z.array(Text),
  created_at: Time.optional(),
  deleted_at: Time.nullable().optional(),
  preset_id: MaybeText.optional(),
  preset_version: z.number().nullable().optional(),
  preset_config: MaybeText.optional(),
  folder_id: MaybeText.optional(),
  hide_results_from_feed: z.number().optional(),
  // Message threads between its agents that hit a limit and await Resume.
  paused_threads: z.number().optional(),
});
export const PublicMessage = z.object({
  id: Text,
  owner_id: Text,
  conversation_id: Text,
  run_id: MaybeText,
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
export const PublicArtifact = z.object({
  id: Text,
  owner_id: Text,
  agent_id: MaybeText,
  conversation_id: MaybeText,
  run_id: MaybeText,
  title: Text,
  kind: ArtifactKindSchema,
  role: ArtifactRoleSchema,
  content: Text,
  metadata: Text,
  folder_id: MaybeText,
  pinned: z.number(),
  archived: z.number(),
  feed_hidden: z.number().optional(),
  version: z.number(),
  created_at: Time,
  updated_at: Time,
  name: MaybeText.optional(),
  provider: Provider.nullable().optional(),
  run_state: RunDisplayState.nullable().optional(),
  run_error: MaybeText.optional(),
});
export const PublicRun = z.object({
  id: Text,
  owner_id: Text.optional(),
  agent_id: MaybeText,
  conversation_id: MaybeText,
  kind: RunKind.optional(),
  input: Text,
  state: RunDisplayState,
  idempotency_key: Text.optional(),
  payload: Text,
  result: MaybeText,
  error: MaybeText,
  created_at: Time,
  updated_at: Time,
  worker_id: MaybeText.optional(),
  heartbeat: Time.nullable().optional(),
  active_ms: z.number().optional(),
  active_since: Time.nullable().optional(),
  queue_rank: z.number().nullable().optional(),
  attention_dismissed_at: Time.nullable().optional(),
  queue_position: z.number().nullable().optional(),
  preview: MaybeText.optional(),
  preview_artifact: PublicArtifact.nullable().optional(),
  steeringId: Text.optional(),
});
export const PublicConversation = z.object({
  id: Text,
  owner_id: Text,
  agent_id: MaybeText,
  title: Text,
  origin: ConversationOrigin,
  external_id: MaybeText,
  created_at: Time,
  team_id: MaybeText,
  execution_connection_id: MaybeText,
  project_id: MaybeText,
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
  run: DoneDisplaySchema.shape.run
    .unwrap()
    .extend({
      created_at: Time,
      updated_at: Time,
      can_move_up: z.boolean().optional(),
      can_move_down: z.boolean().optional(),
      checkout: DoneDisplaySchema.shape.run
        .unwrap()
        .shape.checkout.nullable()
        .optional(),
      verification: DoneDisplaySchema.shape.run
        .unwrap()
        .shape.verification.nullable()
        .optional(),
    })
    .nullable(),
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
export const Approval = z.object({
  id: Text,
  owner_id: Text,
  run_id: Text,
  digest: Text,
  request: Text,
  state: Text,
  result: MaybeText,
  created_at: Time,
  expires_at: Time,
  conversation_id: MaybeText,
  input: Text,
  name: MaybeText,
  provider: Provider.nullable(),
});
export type Approval = z.infer<typeof Approval>;
export const NativeDecision = z.object({
  id: Text,
  run_id: Text,
  conversation_id: Text,
  generation: Text,
  native_id: Text,
  request: Text,
  state: Text,
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
