import {
  ConnectionId,
  FolderId,
  requestId,
  ConversationId,
  ArtifactId,
  OwnerId,
  RunId,
} from "./contract-ids.js";
import { TraceKind } from "./trace-kind.js";
import { RunDisplayState } from "./run-state.js";
import { z } from "zod";
import { AttachmentIds } from "./uploads.js";
import { SessionCapabilities } from "./session-controls.js";

const Text = z.string();
const reserved = new Set([
  "admin",
  "loop",
  "support",
  "system",
  "everyone",
  "all",
  "api",
  "new",
  "deleted",
  "settings",
]);
export const AgentHandle = Text.trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9-]{2,31}$/,
    "Use 3–32 lowercase letters, numbers or hyphens, starting with a letter",
  )
  .refine((name) => !reserved.has(name), "This name is reserved");
export const AgentInput = z.object({
  name: AgentHandle,
  connectionId: requestId(ConnectionId),
  model: Text.min(1).max(150),
  effort: Text.regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .nullable()
    .optional(),
  instructions: Text.max(12000).default(""),
  folderId: requestId(FolderId).optional(),
});
export const AgentCreateInput = AgentInput.extend({
  initialPrompt: Text.trim().max(30000).default(""),
  attachmentIds: AttachmentIds,
  folderId: requestId(FolderId).optional(),
  idempotencyKey: Text.min(8).max(150).optional(),
});
export const AgentUpdateInput = z.object({
  retired: z.boolean().optional(),
  folderId: requestId(FolderId).min(1).nullable().optional(),
  name: AgentHandle.optional(),
  instructions: Text.max(12000).optional(),
  // The existing patch handler treats null like an omitted model/connection.
  connectionId: requestId(ConnectionId).nullish(),
  model: Text.min(1).max(200).nullish(),
  effort: AgentInput.shape.effort,
});
// Inbound credential material. Never reuse these schemas for a response.
export const ConnectionCreateInput = z.object({
  provider: z.enum(["openai", "anthropic"]),
  label: Text.trim().min(1).max(80),
  secret: Text.trim().min(8).max(4096),
});
export const ConnectionReconnectInput = z.object({
  secret: Text.min(8).max(4096),
});
export const PublicModel = z.object({
  id: Text,
  name: Text,
  resolvedModel: Text.optional(),
  capabilities: Text.optional(),
  effortLevels: z
    .array(z.object({ value: Text, description: Text.optional() }))
    .optional(),
  defaultEffort: Text.optional(),
});
export const PublicModels = z.object({ models: z.array(PublicModel) });
export const PublicConnectionRefresh = PublicModels.extend({
  // Native refresh returns these fields; API-key refresh returns only models.
  name: Text.optional(),
  billing: z
    .object({
      mode: z.enum(["subscription", "existing"]),
      description: Text,
      provider: Text.optional(),
      model: Text.nullish(),
    })
    .optional(),
  capabilities: z.record(Text, z.json()).optional(),
});
const PublicHarnessCommand = z.object({
  name: Text,
  token: Text,
  kind: Text,
  description: Text,
  argumentHint: Text.optional(),
  disabledReason: Text.optional(),
  available: z.boolean().optional(),
  reason: Text.optional(),
  sourceInfo: z
    .object({
      source: Text.optional(),
      scope: Text.optional(),
      origin: Text.optional(),
      baseDir: Text.optional(),
      path: Text.optional(),
    })
    .catchall(z.json())
    .optional(),
});
const PublicPiResource = z.object({
  name: Text,
  description: Text,
  kind: z.enum(["skill", "prompt", "extension", "tool"]),
  token: Text.optional(),
  active: z.boolean().optional(),
  scope: Text.optional(),
  source: Text.optional(),
  package: Text.optional(),
  path: Text.optional(),
});
const PublicPiInventory = z.object({
  resources: z.array(PublicPiResource),
  packages: z.array(
    z.object({ path: Text, name: Text, resources: z.number() }),
  ),
  model: z
    .object({
      provider: Text.optional(),
      id: Text.optional(),
      name: Text.optional(),
    })
    .optional(),
  thinkingLevel: Text.optional(),
  source: Text,
  toolsTruncated: z.boolean().optional(),
  projectTrusted: z.boolean().optional(),
  diagnostics: z
    .array(
      z.object({ kind: Text, path: Text.optional(), event: Text.optional() }),
    )
    .optional(),
});
export const PublicHarnessCatalog = z.object({
  available: z.boolean(),
  commands: z.array(PublicHarnessCommand),
  runtime: Text.optional(),
  message: Text.optional(),
  // Claude's subscription runtime also includes its model catalog.
  models: z.array(PublicModel).optional(),
  // Runtime catalogs without a session version omit these display fences.
  generation: Text.optional(),
  revision: z.number().optional(),
  capabilities: SessionCapabilities.optional(),
  inventory: PublicPiInventory.optional(),
});
const PiFilters = z.strictObject({
  extensions: z.array(Text.max(300)).max(100).optional(),
  skills: z.array(Text.max(300)).max(100).optional(),
  prompts: z.array(Text.max(300)).max(100).optional(),
  themes: z.array(Text.max(300)).max(100).optional(),
});
export const PublicPiPackage = z.object({
  source: Text,
  scope: z.enum(["user", "project"]),
  autoload: z.boolean().optional(),
  filters: z.object({
    extensions: z.array(Text).optional(),
    skills: z.array(Text).optional(),
    prompts: z.array(Text).optional(),
    themes: z.array(Text).optional(),
  }),
  settingsHash: Text,
  previousSource: Text.optional(),
  resolvedSource: Text.optional(),
});
export const PublicPiConfiguration = z.object({
  project: Text,
  trust: z.object({
    required: z.boolean(),
    trusted: z.boolean(),
    decision: Text,
    fingerprint: Text,
    paths: z.array(
      z.object({
        path: Text,
        kind: z.enum(["file", "directory"]),
        size: z.number().optional(),
      }),
    ),
    override: z.boolean().optional(),
  }),
  packages: z.array(PublicPiPackage),
  instructions: z.array(
    z.object({
      path: Text,
      role: z.enum([
        "Replace system prompt",
        "Append system prompt",
        "Context",
      ]),
      scope: Text,
      effective: z.boolean(),
    }),
  ),
});
export const PublicPiMutation = PublicPiConfiguration.extend({
  status: z.literal("configured"),
  application: z.literal("new-session"),
});
export const PublicPiInspection = z.object({
  source: Text,
  inspected: z.boolean(),
  resolved: Text.optional(),
  name: Text.optional(),
  description: Text.optional(),
  resources: z.record(Text, z.array(Text)),
  note: Text.optional(),
});
const Source = Text.min(1).max(512),
  Scope = z.enum(["user", "project"]),
  Hash = Text.regex(/^[a-f0-9]{64}$/);
export const PiTrustInput = z.strictObject({
  trusted: z.boolean(),
  fingerprint: Hash,
});
export const PiFiltersInput = z.strictObject({
  source: Source,
  scope: Scope,
  settingsHash: Hash,
  filters: PiFilters,
});
export const PiPreviewInput = z.strictObject({
  name: Text.min(1).max(100),
  args: Text.max(2000),
  conversation: requestId(ConversationId).uuid().optional(),
});
export const PiInspectInput = z.strictObject({ source: Source });
export const PiRollbackInput = z.strictObject({ source: Source, scope: Scope });
export const PiActionInput = PiRollbackInput.extend({
  action: z.enum(["install", "remove", "update"]),
});
export const PublicAgentMessages = z.object({
  items: z.array(
    z.object({
      id: Text,
      content: Text,
      created_at: z.number(),
      conversation_id: ConversationId.nullable(),
      run_id: RunId.nullable(),
      final: z.number(),
      model: Text.nullable(),
    }),
  ),
  next: Text.nullable(),
});
export const PublicAgentTrace = z.object({
  id: z.number(),
  owner_id: OwnerId,
  trace_key: Text,
  run_id: RunId,
  kind: TraceKind,
  title: Text,
  content: Text,
  metadata: Text,
  artifact_id: ArtifactId.nullable(),
  created_at: z.number(),
  input: Text,
  run_state: RunDisplayState,
  run_error: Text.nullable(),
  conversation_id: ConversationId.nullable(),
  server: Text.nullable(),
  invocation_state: Text.nullable(),
});
export const PublicAgentTraces = z.object({
  items: z.array(PublicAgentTrace),
  next: z.number().nullable(),
});
