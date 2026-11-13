import {
  AgentId,
  ConnectionId,
  FolderId,
  MessageId,
  requestId,
  ProjectId,
  ConversationId,
  OwnerId,
  RunId,
} from "./contract-ids.js";
import { z } from "zod";
import { SearchExcerptSchema } from "./search-excerpt.js";
import { ProviderSchema } from "./provider-schema.js";
import { feedCategories } from "./feed-categories.js";
import {
  DefaultArtifactKind,
  OwnerArtifactKindSchema,
} from "./artifact-kind.js";
import { SearchIndexState, SearchMode } from "./search-state.js";
import { ImportStatus } from "./import-status.js";

const Text = z.string(),
  MaybeText = Text.nullable(),
  Num = z.number();
const FolderName = Text.trim().min(1).max(80);
export const UploadOptions = z.object({
  folderId: requestId(FolderId).uuid().optional(),
  agentId: requestId(AgentId).uuid().optional(),
});
export const FolderCreateInput = z.object({
  name: FolderName.refine(
    (x) => !x.includes("/"),
    "Use a name without slashes",
  ),
  path: Text.max(4096).optional(),
  parentId: requestId(FolderId).nullable().default(null),
  kind: z.enum(["project", "folder"]).default("folder"),
});
export const FolderUpdateInput = z.object({
  name: FolderName.refine((x) => !x.includes("/")).optional(),
  path: Text.max(4096).optional(),
  parentId: requestId(FolderId).nullable().optional(),
});
export const ArtifactCreateInput = z.object({
  title: Text.min(1).max(180),
  kind: OwnerArtifactKindSchema.default(DefaultArtifactKind),
  content: Text.max(200000),
  folder: requestId(FolderId).optional(),
  metadata: z
    .object({ snippet: z.literal(true) })
    .strict()
    .optional(),
});
export const ArtifactUpdateInput = z.object({
  title: Text.min(1).max(180).optional(),
  content: Text.max(200000).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  version: Num.int(),
});
export const ArtifactMoveInput = z.object({
  folderId: requestId(FolderId).nullable().optional(),
  command: Text.max(400).optional(),
});
export const PreferencesInput = z.object({
  embeddingEnabled: z.boolean(),
  connectionId: requestId(ConnectionId).nullable(),
});
export const ContinueInput = z.object({
  agentId: requestId(AgentId),
  messageIds: z.array(requestId(MessageId)).min(1).max(200),
  start: z.object({
    input: Text.trim().min(1).max(30000),
    idempotencyKey: Text.min(8).max(150),
  }),
});
// The handler ignores non-string filters and retains its Number(value) coercion
// for numeric filters, including repeated query values.
const Filter = Text.optional().catch(undefined),
  NumericQuery = z.union([Text, z.array(Text)]).optional();
export const ArtifactListQuery = z.object({
  folder: requestId(FolderId).optional(),
  agent: requestId(AgentId).optional(),
  pinned: Filter,
  before: NumericQuery,
});
export const SearchQuery = z.object({
  q: Text.min(1).max(500),
  agent: requestId(AgentId).optional().catch(undefined),
  folder: requestId(FolderId).optional().catch(undefined),
  project: requestId(ProjectId).optional().catch(undefined),
  kind: Filter,
  scope: Filter,
  category: z.enum(feedCategories.map(({ id }) => id)).optional(),
  from: NumericQuery,
  to: NumericQuery,
  before: NumericQuery,
});
export const PublicSearchStatus = z.object({
  enabled: z.boolean(),
  state: SearchIndexState,
  total: Num,
  indexed: Num,
  pending: Num,
  detail: MaybeText,
});
const PublicSearchItem = z.object({
  id: Text,
  owner_id: OwnerId,
  kind: Text,
  title: Text,
  agent_id: AgentId.nullable(),
  conversation_id: ConversationId.nullable(),
  folder_id: FolderId.nullable(),
  created_at: Num,
  updated_at: Num,
  // Agentless documents have no display join; these are not required capabilities.
  name: Text.optional(),
  provider: ProviderSchema.optional(),
  snippet: SearchExcerptSchema,
  score: Num,
  url: Text,
  message_id: MessageId.nullable(),
});
export const PublicSearch = z.object({
  mode: SearchMode,
  detail: MaybeText,
  pending: Num,
  next: Num.nullable(),
  items: z.array(PublicSearchItem),
  semantic: PublicSearchStatus,
});
// A workspace without a preference row returns only embedding_enabled: 0.
// The other branch projects the two keys that SearchSettings actually reads.
export const PublicPreferences = z.union([
  z.object({ embedding_enabled: Num, embedding_connection: MaybeText }),
  z.object({
    embedding_enabled: z.literal(0),
    embedding_connection: z.never().optional(),
  }),
]);
export const PublicImport = z.object({
  id: Text,
  owner_id: OwnerId,
  provider: Text,
  digest: Text,
  status: ImportStatus,
  summary: Text,
  created_at: Num,
});
const PublicImportSummary = z.object({
  objectId: Text,
  conversations: Num,
  messages: Num,
  attachments: Num,
  warnings: z.array(Text),
  titles: z.array(Text),
  completed: Num,
  // Added by execution only after the preview has been accepted.
  agentId: Text.optional(),
  attachmentsStored: z.boolean().optional(),
});
export const PublicImportPreview = z.union([
  PublicImport.extend({
    summary: PublicImportSummary,
    duplicate: z.literal(true),
  }),
  z.object({
    id: Text,
    provider: Text,
    status: ImportStatus,
    summary: PublicImportSummary,
    duplicate: z.never().optional(),
  }),
]);
const PublicCheckoutFile = z.object({
  path: Text,
  additions: Num,
  deletions: Num,
  binary: z.boolean(),
  // Absent on unfiltered files.
  filtered: z.boolean().optional(),
});
const CheckoutStat = z.object({
  files: z.array(PublicCheckoutFile),
  additions: Num,
  deletions: Num,
});
const PublicCheckoutSummary = z.object({
  id: Text,
  state: z.enum(["started", "captured", "failed"]),
  // Present when a start-patch baseline was captured for this run.
  scope: z.literal("run").optional(),
  branch: Text,
  base_ref: MaybeText,
  ahead: Num.nullable(),
  behind: Num.nullable(),
  files: Num,
  additions: Num,
  deletions: Num,
  untracked: Num,
  remote: z.enum(["none", "contains", "missing", "unknown"]),
  started_dirty: z.boolean(),
  overlap: Num,
  late: z.boolean(),
  error: MaybeText,
});
export const PublicCheckout = z.object({
  id: Text,
  owner_id: OwnerId,
  run_id: RunId,
  agent_id: AgentId,
  conversation_id: ConversationId,
  generation: MaybeText,
  directory: Text,
  source: Text,
  branch: Text,
  base_ref: MaybeText,
  base_sha: MaybeText,
  start_head: Text,
  start_dirty: Num,
  start_untracked: Num,
  started_at: Num,
  state: z.enum(["started", "captured", "failed"]),
  end_head: MaybeText,
  ahead: Num.nullable(),
  behind: Num.nullable(),
  files: z.array(PublicCheckoutFile),
  committed: CheckoutStat.nullable(),
  working: CheckoutStat.nullable(),
  untracked: z.array(Text),
  patch: MaybeText,
  patch_bytes: Num.nullable(),
  patch_truncated: z.boolean(),
  remote: z
    .object({
      ref: Text,
      sha: Text,
      contains_head: z.boolean().nullable(),
      observed_at: Num,
    })
    .nullable(),
  overlap: z.array(Text),
  captured_late: z.boolean(),
  summary: PublicCheckoutSummary.nullable(),
  ended_at: Num.nullable(),
  error: MaybeText,
});
export const PublicVerification = z.object({
  id: Text,
  kind: z.enum(["test", "typecheck", "lint"]),
  tools: z.array(Text),
  command: Text,
  status: z.enum(["passed", "failed", "unknown"]),
  exit_code: Num.nullable(),
  truncated: z.boolean(),
  observed_at: Num,
  output_tail: MaybeText,
});
