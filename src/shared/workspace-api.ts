import { z } from "zod";
import { DoneDisplaySchema } from "./done-card.js";
import { WorkspaceClock } from "./workspace-events.js";
import { ProjectedMessage } from "./transcript-projection.js";
import { SessionControls } from "./session-controls.js";
import { AttachmentIds } from "./uploads.js";
import { REPLY_EXCERPT_LIMIT } from "./replies.js";

// Owner-session HTTP projections. Never import a storage row or credential schema here.
const Text = z.string(), MaybeText = Text.nullable(), Time = z.number();
const Provider = z.enum(["openai", "anthropic", "codex", "pi", "opencode", "gemini", "muse", "grok", "acp"]);
export const PublicAgent = z.object({
  id: Text, owner_id: Text, name: Text, normalized_name: Text.optional(), provider: Provider,
  connection_id: MaybeText, model: Text, effort: MaybeText.optional(), instructions: Text,
  folder_id: MaybeText.optional(), origin: Text, retired_at: Time.nullable().optional(), created_at: Time,
});
export const PublicConnection = z.object({
  id: Text, provider: Provider, label: Text, status: Text, models: Text, metadata: Text,
});
export const PublicFolder = z.object({
  id: Text, owner_id: Text.optional(), name: Text, parent_id: MaybeText,
  kind: z.enum(["folder", "project"]), created_at: Time.optional(),
  path: MaybeText.optional(), is_workspace: z.union([z.boolean(), z.number()]).optional(),
});
export const PublicTeam = z.object({
  id: Text, owner_id: Text.optional(), name: Text, manager_id: Text, conversation_id: MaybeText,
  members: z.array(Text), created_at: Time.optional(), deleted_at: Time.nullable().optional(),
  preset_id: MaybeText.optional(), preset_version: z.number().nullable().optional(), preset_config: MaybeText.optional(), folder_id: MaybeText.optional(),
  hide_results_from_feed: z.number().optional(), paused_threads: z.number().optional(),
});
const PublicMessage = z.object({
  id: Text, owner_id: Text, conversation_id: Text, run_id: MaybeText,
  role: z.enum(["user", "assistant", "system", "tool"]), content: Text, metadata: Text, created_at: Time,
  revision: z.number().optional(), update_key: MaybeText.optional(), transcript_ordinal: z.number().nullable().optional(),
  run_state: MaybeText.optional(), run_error: MaybeText.optional(), run_checkout: MaybeText.optional(), run_verification: MaybeText.optional(),
});
export const PublicArtifact = z.object({
  id: Text, owner_id: Text, agent_id: MaybeText, conversation_id: MaybeText, run_id: MaybeText,
  title: Text, kind: Text, content: Text, metadata: Text, folder_id: MaybeText,
  pinned: z.number(), archived: z.number(), feed_hidden: z.number().optional(), version: z.number(),
  created_at: Time, updated_at: Time, name: MaybeText.optional(), provider: Provider.nullable().optional(),
  run_state: MaybeText.optional(), run_error: MaybeText.optional(),
});
export const PublicRun = z.object({
  id: Text, owner_id: Text.optional(), agent_id: MaybeText, conversation_id: MaybeText,
  kind: Text.optional(), input: Text, state: Text, idempotency_key: Text.optional(), payload: Text,
  result: MaybeText, error: MaybeText, created_at: Time, updated_at: Time,
  worker_id: MaybeText.optional(), heartbeat: Time.nullable().optional(),
  active_ms: z.number().optional(), active_since: Time.nullable().optional(),
  queue_rank: z.number().nullable().optional(), attention_dismissed_at: Time.nullable().optional(),
  queue_position: z.number().nullable().optional(), preview: MaybeText.optional(), stage: MaybeText.optional(),
  preview_artifact: PublicArtifact.nullable().optional(), steeringId: Text.optional(),
});
const PublicConversation = z.object({
  id: Text, owner_id: Text, agent_id: MaybeText, title: Text, origin: Text, external_id: MaybeText, created_at: Time,
  team_id: MaybeText, execution_backend: Text, execution_connection_id: MaybeText, project_id: MaybeText,
  // Legacy linked sources can omit these operational display columns.
  feed_hidden: z.number().optional(), feed_run_id: MaybeText.optional(), feed_run_raw_state: MaybeText.optional(), feed_run_state: MaybeText.optional(),
  feed_run_dismissed_at: Time.nullable().optional(), feed_queued: z.number().optional(), feed_done_run_id: MaybeText.optional(), feed_done_at: Time.nullable().optional(),
  feed_last_activity_at: Time.nullable().optional(), feed_last_message_id: MaybeText.optional(), feed_folder_id: MaybeText.optional(),
  feed_visible: z.number().optional(), feed_approval_until: Time.nullable().optional(),
});
export const Bootstrap = z.object({
  agents: z.array(PublicAgent), connections: z.array(PublicConnection), folders: z.array(PublicFolder), teams: z.array(PublicTeam).optional(),
  // Older source catalogs omitted these additions. Absence grants no capability.
  environmentName: Text.optional(), identityProviders: z.array(Text).optional(), capabilities: z.object({ codex: z.boolean(), claudeLogin: z.boolean() }).optional(),
  preview: z.object({ name: Text, mode: z.enum(["design", "working"]), build: z.object({
    id: Text, branch: Text, commit: Text, dirty: z.boolean(), builtAt: Text, sourceHash: Text, artifactHash: Text,
  }) }).optional(),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

export const FEED_FILTERS = ["all", "done", "needs", "working", "queued", "later", "outcomes", "unfinished"] as const;
export const FeedItem = DoneDisplaySchema.extend({
  // Missing means this source cannot report PR state; null means no watch.
  pull: DoneDisplaySchema.shape.pull.optional(),
  last_activity_at: Time,
  last_message: DoneDisplaySchema.shape.last_message.unwrap().extend({ created_at: Time, content: Text.optional(), saved: z.boolean().optional() }).nullable(),
  run: DoneDisplaySchema.shape.run.unwrap().extend({ created_at: Time, updated_at: Time, can_move_up: z.boolean().optional(), can_move_down: z.boolean().optional(), checkout: DoneDisplaySchema.shape.run.unwrap().shape.checkout.nullable().optional(), verification: DoneDisplaySchema.shape.run.unwrap().shape.verification.nullable().optional() }).nullable(),
  done_card_key: Text.optional(), position_message_id: MaybeText,
  later: DoneDisplaySchema.shape.later.unwrap().extend({ condition: MaybeText, due_at: Time.nullable(), surfaced_at: Time.nullable() }).nullable(),
  queued_runs: z.array(z.object({ id: Text, input: Text, created_at: Time, queue_position: z.number().nullable(), can_edit: z.boolean(), can_move_up: z.boolean(), can_move_down: z.boolean() })).optional(),
  live_preview: MaybeText.optional(), pending_approvals: z.number(),
  next_action: z.object({ kind: z.enum(["approve", "answer", "result"]), message_id: MaybeText, run_id: Text, ref: Text.optional() }).nullable().optional(),
});
export const FeedPage = z.object({
  items: z.array(FeedItem), next: MaybeText,
  summary: z.object({ needs: z.number(), working: z.number(), queued: z.number(), later_due: z.number(), social_unread: z.number().optional(), scheduled_failed: z.number().optional(), scheduled_pending: z.number().optional() }),
  projection: WorkspaceClock.optional(),
});
export type FeedPage = z.infer<typeof FeedPage>;
// Older linked workspaces may omit the handoff, range and resume markers.
export const ConversationPage = z.object({
  conversation: PublicConversation, messages: z.array(PublicMessage.extend({ cursor: ProjectedMessage.shape.cursor })),
  next: MaybeText, range: z.object({ from: ProjectedMessage.shape.cursor, before: ProjectedMessage.shape.cursor }).optional(),
  position_message_id: MaybeText, saved: z.array(Text), steerable_run_id: MaybeText.optional(), resumed: z.boolean().optional(), projection: WorkspaceClock.optional(),
});
export type ConversationPage = z.infer<typeof ConversationPage>;
const ResultFields = { cursor: z.number(), agent_id: MaybeText, team_id: MaybeText, name: MaybeText, provider: Provider.nullable(), folder_id: MaybeText.optional() };
export const ResultItem = z.union([PublicArtifact.extend(ResultFields), PublicMessage.extend(ResultFields)]);
export type ResultItem = z.infer<typeof ResultItem>;
const ResultsPage = z.object({ items: z.array(ResultItem), next: z.number().nullable(), revision: z.number(), projection: WorkspaceClock.optional() });
const ResultsUpdates = z.object({ items: z.array(ResultItem), removed: z.array(Text), revision: z.number(), more: z.boolean(), projection: WorkspaceClock.optional() });
export const Approval = z.object({
  id: Text, owner_id: Text, run_id: Text, digest: Text, request: Text, state: Text, result: MaybeText,
  created_at: Time, expires_at: Time, conversation_id: MaybeText, input: Text, name: MaybeText, provider: Provider.nullable(),
});
export type Approval = z.infer<typeof Approval>;
export const NativeDecision = z.object({
  id: Text, run_id: Text, conversation_id: Text, generation: Text, native_id: Text, request: Text, state: Text,
  command_id: MaybeText, digest: MaybeText, created_at: Time, name: MaybeText, provider: Provider.nullable(), input: Text,
});
export type NativeDecision = z.infer<typeof NativeDecision>;

const Empty = z.object({}), NoBody = z.undefined();
const Id = z.object({ id: Text });
const Teams = Text.max(2000).optional();
const Ok = z.object({ ok: z.boolean() });
const ResultSelection = { agent: Text.optional(), folder: Text.optional(), teams: Teams, view: z.enum(["all", "prompts", "files"]).default("all"), saved: z.enum(["1", "0"]).optional() };
const NumberCursor = z.coerce.number<string>().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type RouteContract = {
  method: "GET" | "POST" | "PATCH"; path: string; params: z.ZodType; query: z.ZodType; body: z.ZodType; response: z.ZodType;
};
const endpoint = <const C extends RouteContract>(contract: C) => contract;
const base = { params: Empty, query: Empty, body: NoBody };
export const workspaceApi = {
  bootstrap: endpoint({ ...base, method: "GET", path: "/bootstrap", response: Bootstrap }),
  feed: endpoint({ ...base, method: "GET", path: "/feed", query: z.object({ filter: z.enum(FEED_FILTERS).default("all"), expand: z.literal("results").optional(), folder: Text.min(1).max(150).optional(), agent: Text.min(1).max(150).optional(), before: Text.min(1).max(512).optional(), teams: Teams }), response: FeedPage }),
  conversation: endpoint({ ...base, method: "GET", path: "/conversations/:id", params: Id, query: z.object({ before: Text.max(512).optional(), message: Text.max(150).optional(), resume: z.enum(["0", "1"]).optional() }), response: ConversationPage }),
  runs: endpoint({ ...base, method: "GET", path: "/runs", query: z.object({ teams: Teams, active: Text.optional() }), response: z.array(PublicRun) }),
  submit: endpoint({ ...base, method: "POST", path: "/runs", body: z.object({
    agentId: Text, conversationId: Text.optional(), replyToMessageId: Text.min(1).max(150).optional(), replyExcerpt: Text.trim().min(1).max(REPLY_EXCERPT_LIMIT).optional(),
    input: Text.trim().min(1).max(30000), attachmentIds: AttachmentIds, idempotencyKey: Text.min(8).max(150), folderId: Text.min(1).nullable().optional(), queue: z.boolean().optional(),
  }).refine(d => !d.replyExcerpt || d.replyToMessageId, { message: "Choose the message the excerpt comes from", path: ["replyExcerpt"] }), response: PublicRun }),
  runAction: endpoint({ ...base, method: "POST", path: "/runs/:id/:action", params: Id.extend({ action: Text }), body: z.object({ idempotencyKey: Text.min(8).max(150).optional() }).optional(), response: z.union([PublicRun, Ok]) }),
  results: endpoint({ ...base, method: "GET", path: "/results", query: z.object({ ...ResultSelection, view: Text.optional(), saved: Text.optional(), before: z.coerce.number<string>().min(0).catch(0).default(0) }), response: ResultsPage }),
  resultUpdates: endpoint({ ...base, method: "GET", path: "/results/updates", query: z.object({ ...ResultSelection, after: NumberCursor, through: NumberCursor }), response: ResultsUpdates }),
  approvals: endpoint({ ...base, method: "GET", path: "/approvals", query: z.object({ teams: Teams }), response: z.array(Approval) }),
  approval: endpoint({ ...base, method: "POST", path: "/approvals/:id", params: Id, body: z.object({ decision: z.enum(["approve", "reject"]) }), response: Ok }),
  nativeDecisions: endpoint({ ...base, method: "GET", path: "/native/decisions", query: z.object({ conversation: Text.uuid().optional() }), response: z.array(NativeDecision) }),
  nativeAnswer: endpoint({ ...base, method: "POST", path: "/native/decisions/:id", params: Id, body: z.strictObject({ commandId: Text.uuid(), answer: z.record(Text, z.json()) }), response: z.object({ state: Text }) }),
  session: endpoint({ ...base, method: "GET", path: "/conversations/:id/settings", params: z.object({ id: Text.uuid() }), response: SessionControls }),
  setting: endpoint({ ...base, method: "PATCH", path: "/conversations/:id/settings/:setting", params: z.object({ id: Text.uuid(), setting: Text }), body: z.strictObject({ value: z.union([Text.max(1000), z.boolean(), z.number()]), revision: z.number().int().nonnegative(), generation: Text.min(1).max(200), commandId: Text.uuid().optional() }), response: SessionControls }),
} as const;

type Field<K extends string, S extends z.ZodType> = undefined extends z.input<S> ? { [P in K]?: z.input<S> } : {} extends z.input<S> ? { [P in K]?: z.input<S> } : { [P in K]: z.input<S> };
export type RouteInput<C extends RouteContract> = Field<"params", C["params"]> & Field<"query", C["query"]> & Field<"body", C["body"]>;
export type RouteResponse<C extends RouteContract> = z.output<C["response"]>;
