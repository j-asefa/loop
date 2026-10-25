import { FeedEntities } from "./feed-projection.js";
import { z } from "zod";
import * as mobile from "./mobile-contract-schemas.js";
import * as library from "./library-contract-schemas.js";
import { ProviderSchema as Provider } from "./provider-schema.js";
import { PersonalFilesQuery, PersonalFilesPage } from "./personal-files.js";
import { PersonalDecisionsQuery, PersonalDecisionsPageSchema } from "./personal-decisions.js";
import { ProfileInput, PublicProfile, PersonalPromptsQuery, PersonalPromptsPage } from "./personal-schemas.js";
import { AgentCreateInput, AgentUpdateInput, ConnectionCreateInput, ConnectionReconnectInput, PublicModels, PublicConnectionRefresh, PublicHarnessCatalog, PublicPiConfiguration, PublicPiMutation, PublicPiInspection, PiTrustInput, PiFiltersInput, PiPreviewInput, PiInspectInput, PiRollbackInput, PiActionInput, PublicAgentMessages, PublicAgentTraces } from "./agent-contract-schemas.js";
import { DoneDisplaySchema } from "./done-card.js";
import { WorkspaceClock } from "./workspace-events.js";
import { ProjectedMessage } from "./transcript-projection.js";
import { SessionControls } from "./session-controls.js";
import { AttachmentIds } from "./uploads.js";
import { REPLY_EXCERPT_LIMIT } from "./replies.js";
import { CardSchema, CardIdSchema, CardPageSchema, CardChangesSchema, CardListQuerySchema, CardChangesQuerySchema } from "./cards.js";
import { CardTokenSchema, CreateCardTokenSchema } from "./card-token-schemas.js";

// Owner-session HTTP projections. Never import a storage row or credential schema here.
const Text = z.string(), MaybeText = Text.nullable(), Time = z.number();
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
export const PublicMessage = z.object({
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
  projectionRows: FeedEntities.optional(),
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

export const CardErrorSchema = z.object({ error: z.string() });
export const CreatedCardTokenSchema = z.object({ token: CardTokenSchema, secret: z.string() });

const Empty = z.object({}), NoBody = z.undefined();
const Id = z.object({ id: Text });
const Teams = Text.max(2000).optional();
const Ok = z.object({ ok: z.boolean() });
const ResultSelection = { agent: Text.optional(), folder: Text.optional(), teams: Teams, view: z.enum(["all", "prompts", "files"]).default("all"), saved: z.enum(["1", "0"]).optional() };
const NumberCursor = z.coerce.number<string>().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type RouteContract = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; params: z.ZodType; query: z.ZodType; body: z.ZodType; response: z.ZodType;
  status?: number;
  // Other success statuses the handler writes (for example an accepted replay).
  additionalStatuses?: readonly number[];
  kind?: "stream";
  // One file part named "file", plus the ordinary body schema's text fields.
  multipart?: true;
  contentType?: string;
  access: "session" | "card:results" | "card:cards";
};
const endpoint = <const C extends RouteContract>(contract: C) => contract;
const base = { params: Empty, query: Empty, body: NoBody, access: "session" as const };
export const workspaceApi = {
  // All three reads admit either grant; card:results names the minimum grant.
  // The admission boundary still limits each grant's selections and excludes Done.
  cardList: endpoint({ ...base, method: "GET", path: "/v1/cards", query: CardListQuerySchema, response: CardPageSchema, access: "card:results" }),
  cardChanges: endpoint({ ...base, method: "GET", path: "/v1/cards/changes", query: CardChangesQuerySchema, response: CardChangesSchema, access: "card:results" }),
  cardDetail: endpoint({ ...base, method: "GET", path: "/v1/cards/:id", params: z.object({ id: CardIdSchema }), query: z.strictObject({}, { error: "Card detail does not accept query parameters" }), response: CardSchema, access: "card:results" }),
  // Management handlers historically ignore query parameters.
  cardTokens: endpoint({ ...base, method: "GET", path: "/card-tokens", response: z.array(CardTokenSchema) }),
  cardTokenCreate: endpoint({ ...base, method: "POST", path: "/card-tokens", body: CreateCardTokenSchema, response: CreatedCardTokenSchema, status: 201 }),
  cardTokenRevoke: endpoint({ ...base, method: "DELETE", path: "/card-tokens/:id", params: z.object({ id: Text.min(1) }), response: z.object({ ok: z.literal(true) }) }),
  connectionCreate: endpoint({ ...base, method: "POST", path: "/connections", body: ConnectionCreateInput, response: PublicConnection.pick({ id: true }).extend(PublicModels.shape) }),
  connectionRefresh: endpoint({ ...base, method: "POST", path: "/connections/:id/refresh", params: Id, body: z.unknown(), response: PublicConnectionRefresh }),
  connectionModels: endpoint({ ...base, method: "GET", path: "/connections/:id/models", params: Id, response: PublicModels }),
  connectionReconnect: endpoint({ ...base, method: "POST", path: "/connections/:id/reconnect", params: Id, body: ConnectionReconnectInput, response: Ok }),
  connectionDisconnect: endpoint({ ...base, method: "DELETE", path: "/connections/:id", params: Id, body: z.unknown(), response: Ok }),
  agentSuggestName: endpoint({ ...base, method: "GET", path: "/agents/suggest-name", response: z.object({ name: Text }) }),
  agentCreate: endpoint({ ...base, method: "POST", path: "/agents", body: AgentCreateInput, response: PublicAgent.extend({ initialRun: z.object({ id: Text, conversation_id: MaybeText }).optional() }), status: 201 }),
  agentUpdate: endpoint({ ...base, method: "PATCH", path: "/agents/:id", params: Id, body: AgentUpdateInput, response: PublicAgent }),
  agentDetail: endpoint({ ...base, method: "GET", path: "/agents/:id", params: Id, response: z.object({ agent: PublicAgent, runs: z.array(PublicRun), conversations: z.array(PublicConversation) }) }),
  agentHarness: endpoint({ ...base, method: "GET", path: "/agents/:id/harness", params: Id, query: z.object({ conversation: Text.uuid().optional() }), response: PublicHarnessCatalog }),
  agentMessages: endpoint({ ...base, method: "GET", path: "/agents/:id/messages", params: Id, query: z.object({ before: Text.min(1).max(512).optional() }), response: PublicAgentMessages }),
  agentTraces: endpoint({ ...base, method: "GET", path: "/agents/:id/traces", params: Id, query: z.object({ before: z.coerce.number<string>().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), run: Text.min(1).max(100).optional(), q: Text.max(500).optional() }), response: PublicAgentTraces }),
  agentTracesExport: endpoint({ ...base, method: "GET", path: "/agents/:id/traces/export", params: Id, query: z.object({ run: Text.min(1).max(100) }), kind: "stream", contentType: "application/json", response: z.custom<Blob>() }),
  agentPiPackages: endpoint({ ...base, method: "GET", path: "/agents/:id/pi-packages", params: Id, response: PublicPiConfiguration }),
  agentPiTrust: endpoint({ ...base, method: "POST", path: "/agents/:id/pi-trust", params: Id, body: PiTrustInput, response: PublicPiConfiguration }),
  agentPiFilters: endpoint({ ...base, method: "POST", path: "/agents/:id/pi-package-filters", params: Id, body: PiFiltersInput, response: PublicPiMutation }),
  agentPiPreview: endpoint({ ...base, method: "POST", path: "/agents/:id/pi-prompt-preview", params: Id, body: PiPreviewInput, response: z.object({ token: Text, expanded: Text }) }),
  agentPiInspect: endpoint({ ...base, method: "POST", path: "/agents/:id/pi-package-inspect", params: Id, body: PiInspectInput, response: PublicPiInspection }),
  agentPiRollback: endpoint({ ...base, method: "POST", path: "/agents/:id/pi-package-rollback", params: Id, body: PiRollbackInput, response: PublicPiMutation }),
  agentPiAction: endpoint({ ...base, method: "POST", path: "/agents/:id/pi-packages", params: Id, body: PiActionInput, response: PublicPiMutation }),
  messageSearch: endpoint({ ...base, method: "GET", path: "/messages", query: z.object({ q: Text.max(500).default("") }), response: z.array(PublicMessage) }),
  messageDetail: endpoint({ ...base, method: "GET", path: "/messages/:id", params: Id, response: PublicMessage }),
  resultUpdate: endpoint({ ...base, method: "PATCH", path: "/results/:id", params: Id, body: z.object({ hidden: z.boolean() }), response: Ok }),
  artifactFile: endpoint({ ...base, method: "GET", path: "/artifacts/:id/file", params: Id, query: z.object({ preview: z.unknown().optional() }), kind: "stream", response: z.custom<Blob>() }),
  artifactDownload: endpoint({ ...base, method: "GET", path: "/artifacts/:id/download", params: Id, kind: "stream", response: z.custom<Blob>(), status: 303 }),
  personalFiles: endpoint({ ...base, method: "GET", path: "/me/files", query: PersonalFilesQuery, response: PersonalFilesPage }),
  personalDecisions: endpoint({ ...base, method: "GET", path: "/me/decisions", query: PersonalDecisionsQuery, response: PersonalDecisionsPageSchema }),
  personalProfile: endpoint({ ...base, method: "GET", path: "/me/profile", response: PublicProfile }),
  personalProfileUpdate: endpoint({ ...base, method: "PUT", path: "/me/profile", body: ProfileInput, response: PublicProfile }),
  personalPrompts: endpoint({ ...base, method: "GET", path: "/me/prompts", query: PersonalPromptsQuery, response: PersonalPromptsPage }),
  conversationPosition: endpoint({ ...base, method: "PUT", path: "/conversations/:id/position", params: Id, body: mobile.PositionInput, response: z.object({ position_message_id: MaybeText }) }),
  feedUpdate: endpoint({ ...base, method: "PATCH", path: "/feed/:id", params: Id, body: mobile.FeedUpdateInput, response: Ok }),
  feedAway: endpoint({ ...base, method: "GET", path: "/feed/away", query: z.object({ since: NumberCursor.default(0) }), response: mobile.PublicAway }),
  messageSave: endpoint({ ...base, method: "POST", path: "/messages/:id/saved", params: Id, body: z.unknown(), response: Ok.extend({ saved: z.boolean() }) }),
  messageUnsave: endpoint({ ...base, method: "DELETE", path: "/messages/:id/saved", params: Id, body: z.unknown(), response: Ok.extend({ saved: z.boolean() }) }),
  savedList: endpoint({ ...base, method: "GET", path: "/saved", query: z.object({ before: Text.max(500).optional(), folder: Text.max(150).optional(), teams: Teams, q: Text.max(200).optional() }), response: z.object({ items: z.array(z.discriminatedUnion("kind", [
    // Sources before Saved labels (#40, 74d4971a) omit the envelope label.
    z.object({ kind: z.literal("message"), key: Text, saved_at: Time, label: MaybeText.optional(), message: mobile.PublicSavedMessage }),
    z.object({ kind: z.literal("result"), key: Text, saved_at: Time, label: MaybeText.optional(), result: PublicArtifact.extend({ team_id: MaybeText }) }),
  ])), next: MaybeText }) }),
  savedLabel: endpoint({ ...base, method: "PUT", path: "/saved/label", body: mobile.SavedLabelInput, response: z.object({ key: Text, label: MaybeText }) }),
  conversationOutline: endpoint({ ...base, method: "GET", path: "/conversations/:id/outline", params: Id, query: z.object({ q: Text.max(200).optional() }), response: mobile.PublicOutline }),
  laterCreate: endpoint({ ...base, method: "POST", path: "/later", body: mobile.LaterInput, response: mobile.PublicCreatedLater, status: 201 }),
  laterList: endpoint({ ...base, method: "GET", path: "/later", response: mobile.PublicLaterList }),
  laterFinish: endpoint({ ...base, method: "DELETE", path: "/later/:id", params: Id, body: z.unknown(), response: Ok }),
  laterSnooze: endpoint({ ...base, method: "POST", path: "/later/:id/snooze", params: Id, body: mobile.LaterInput.pick({ condition: true, dueAt: true, projectId: true }), response: mobile.PublicLater }),
  laterReopen: endpoint({ ...base, method: "POST", path: "/later/:id/reopen", params: Id, body: z.unknown(), response: mobile.PublicLater }),
  projectOpened: endpoint({ ...base, method: "POST", path: "/projects/:id/opened", params: Id, body: z.unknown(), response: z.object({ surfaced: z.number() }) }),
  projectSummaries: endpoint({ ...base, method: "GET", path: "/projects/summary", response: mobile.PublicProjectSummaries }),
  scheduledSendCreate: endpoint({ ...base, method: "POST", path: "/scheduled-sends", body: mobile.ScheduleInput, response: mobile.PublicScheduledSend, status: 201, additionalStatuses: [200] }),
  scheduledSendList: endpoint({ ...base, method: "GET", path: "/scheduled-sends", query: z.object({ conversation: Text.min(1).max(150).optional(), failedBefore: Text.max(500).optional() }), response: mobile.PublicScheduledList }),
  scheduledSendCancel: endpoint({ ...base, method: "DELETE", path: "/scheduled-sends/:id", params: Id, body: z.unknown(), response: Ok }),
  scheduledSendUpdate: endpoint({ ...base, method: "PATCH", path: "/scheduled-sends/:id", params: Id, body: mobile.ScheduleUpdateInput.optional(), response: mobile.PublicScheduledSend }),
  scheduledSendRetry: endpoint({ ...base, method: "POST", path: "/scheduled-sends/:id/retry", params: Id, body: z.unknown(), response: z.object({ run: PublicRun.nullable(), row: mobile.PublicScheduledSend }) }),
  runReorder: endpoint({ ...base, method: "POST", path: "/runs/:id/reorder", params: Id, body: mobile.RunReorderInput, response: Ok }),
  runUpdate: endpoint({ ...base, method: "PATCH", path: "/runs/:id", params: Id, body: mobile.QueuedRunInput, response: Ok }),
  runWithdraw: endpoint({ ...base, method: "POST", path: "/runs/:id/withdraw", params: Id, body: mobile.RunWithdrawInput.optional(), response: mobile.PublicWithdrawnDraft }),
  runMove: endpoint({ ...base, method: "POST", path: "/runs/:id/move", params: Id, body: mobile.RunMoveInput, response: PublicRun, status: 202 }),
  conversationFork: endpoint({ ...base, method: "POST", path: "/conversations/:id/fork", params: Id, body: mobile.ConversationForkInput, response: z.object({ id: Text, agentId: Text }) }),
  conversationUsage: endpoint({ ...base, method: "GET", path: "/conversations/:id/usage", params: Id, response: mobile.PublicUsage }),
  snippetList: endpoint({ ...base, method: "GET", path: "/snippets", response: mobile.PublicSnippets }),
  uploadCreate: endpoint({ ...base, method: "POST", path: "/uploads", multipart: true, body: library.UploadOptions, response: mobile.PublicUploadDescriptor, status: 201 }),
  folderList: endpoint({ ...base, method: "GET", path: "/folders", response: z.array(PublicFolder) }),
  folderCreate: endpoint({ ...base, method: "POST", path: "/folders", body: library.FolderCreateInput, response: PublicFolder, status: 201 }),
  folderUpdate: endpoint({ ...base, method: "PATCH", path: "/folders/:id", params: Id, body: library.FolderUpdateInput, response: Ok }),
  artifactList: endpoint({ ...base, method: "GET", path: "/artifacts", query: library.ArtifactListQuery, response: z.object({ items: z.array(PublicArtifact.extend({ cursor: z.number(), name: MaybeText, provider: Provider.nullable() })), next: z.number().nullable() }) }),
  artifactDetail: endpoint({ ...base, method: "GET", path: "/artifacts/:id", params: Id, response: PublicArtifact }),
  artifactCreate: endpoint({ ...base, method: "POST", path: "/artifacts", body: library.ArtifactCreateInput, response: z.object({ id: Text }), status: 201 }),
  artifactUpdate: endpoint({ ...base, method: "PATCH", path: "/artifacts/:id", params: Id, body: library.ArtifactUpdateInput, response: PublicArtifact }),
  artifactMove: endpoint({ ...base, method: "POST", path: "/artifacts/:id/move", params: Id, body: library.ArtifactMoveInput, response: z.object({ operation: Text, folderId: MaybeText, message: Text }) }),
  runCheckout: endpoint({ ...base, method: "GET", path: "/runs/:id/checkout", params: Id, response: library.PublicCheckout }),
  runVerifications: endpoint({ ...base, method: "GET", path: "/runs/:id/verifications", params: Id, response: z.array(library.PublicVerification) }),
  runFiles: endpoint({ ...base, method: "GET", path: "/runs/:id/files", params: Id, response: z.array(z.object({ id: Text, title: Text, metadata: Text })) }),
  operationUndo: endpoint({ ...base, method: "POST", path: "/operations/:id/undo", params: Id, body: z.unknown(), response: Ok.extend({ folderId: MaybeText }) }),
  objectFile: endpoint({ ...base, method: "GET", path: "/objects/:id", params: Id, query: z.object({ preview: z.unknown().optional() }), kind: "stream", response: z.custom<Blob>() }),
  search: endpoint({ ...base, method: "GET", path: "/search", query: library.SearchQuery, response: library.PublicSearch }),
  searchStatus: endpoint({ ...base, method: "GET", path: "/search/status", response: library.PublicSearchStatus }),
  preferences: endpoint({ ...base, method: "GET", path: "/preferences", response: library.PublicPreferences }),
  preferencesUpdate: endpoint({ ...base, method: "POST", path: "/preferences", body: library.PreferencesInput, response: Ok }),
  importPreview: endpoint({ ...base, method: "POST", path: "/imports/preview", multipart: true, body: Empty, response: library.PublicImportPreview }),
  importList: endpoint({ ...base, method: "GET", path: "/imports", response: z.array(library.PublicImport) }),
  importStart: endpoint({ ...base, method: "POST", path: "/imports/:id/start", params: Id, body: z.unknown(), response: z.union([PublicRun, z.object({ status: z.literal("completed") })]) }),
  importCancel: endpoint({ ...base, method: "POST", path: "/imports/:id/cancel", params: Id, body: z.unknown(), response: Ok }),
  conversationContinue: endpoint({ ...base, method: "POST", path: "/conversations/:id/continue", params: Id, body: library.ContinueInput, response: z.object({ id: Text, agentId: Text }) }),
  bootstrap: endpoint({ ...base, method: "GET", path: "/bootstrap", response: Bootstrap }),
  feed: endpoint({ ...base, method: "GET", path: "/feed", query: z.object({ filter: z.enum(FEED_FILTERS).default("all"), expand: z.literal("results").optional(), folder: Text.min(1).max(150).optional(), agent: Text.min(1).max(150).optional(), before: Text.min(1).max(512).optional(), teams: Teams, known: Text.optional() }), response: FeedPage }),
  conversation: endpoint({ ...base, method: "GET", path: "/conversations/:id", params: Id, query: z.object({ before: Text.max(512).optional(), message: Text.max(150).optional(), resume: z.enum(["0", "1"]).optional() }), response: ConversationPage }),
  runs: endpoint({ ...base, method: "GET", path: "/runs", query: z.object({ teams: Teams, active: Text.optional() }), response: z.array(PublicRun) }),
  submit: endpoint({ ...base, method: "POST", path: "/runs", body: z.object({
    agentId: Text, conversationId: Text.optional(), replyToMessageId: Text.min(1).max(150).optional(), replyExcerpt: Text.trim().min(1).max(REPLY_EXCERPT_LIMIT).optional(),
    input: Text.trim().min(1).max(30000), attachmentIds: AttachmentIds, idempotencyKey: Text.min(8).max(150), folderId: Text.min(1).nullable().optional(), queue: z.boolean().optional(),
  }).refine(d => !d.replyExcerpt || d.replyToMessageId, { message: "Choose the message the excerpt comes from", path: ["replyExcerpt"] }), response: PublicRun, status: 202 }),
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
export type RouteInput<C extends RouteContract> = Field<"params", C["params"]> & Field<"query", C["query"]> & Field<"body", C["body"]> & (C extends { multipart: true } ? { file: Blob; filename?: string } : {});
export type RouteResponse<C extends RouteContract> = z.output<C["response"]>;
