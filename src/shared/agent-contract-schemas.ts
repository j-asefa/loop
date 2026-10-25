import { z } from "zod";
import { AttachmentIds } from "./uploads.js";
import { SessionCapabilities } from "./session-controls.js";

const Text = z.string();
const reserved = new Set(["admin", "loop", "support", "system", "everyone", "all", "api", "new", "deleted", "settings"]);
export const AgentHandle = Text.trim().toLowerCase()
  .regex(/^[a-z][a-z0-9-]{2,31}$/, "Use 3–32 lowercase letters, numbers or hyphens, starting with a letter")
  .refine(name => !reserved.has(name), "This name is reserved");
export const AgentInput = z.object({
  name: AgentHandle, connectionId: Text, model: Text.min(1).max(150),
  effort: Text.regex(/^[a-z][a-z0-9_-]{0,31}$/).nullable().optional(),
  instructions: Text.max(12000).default(""), folderId: Text.optional(),
});
export const AgentCreateInput = AgentInput.extend({
  initialPrompt: Text.trim().max(30000).default(""), attachmentIds: AttachmentIds,
  folderId: Text.optional(), idempotencyKey: Text.min(8).max(150).optional(),
});
export const AgentUpdateInput = z.object({
  retired: z.boolean().optional(), folderId: Text.min(1).nullable().optional(),
  name: AgentHandle.optional(), instructions: Text.max(12000).optional(),
  // The existing patch handler treats null like an omitted model/connection.
  connectionId: Text.nullish(), model: Text.min(1).max(200).nullish(), effort: AgentInput.shape.effort,
});
// Inbound credential material. Never reuse these schemas for a response.
export const ConnectionCreateInput = z.object({
  provider: z.enum(["openai", "anthropic"]), label: Text.trim().min(1).max(80), secret: Text.trim().min(8).max(4096),
});
export const ConnectionReconnectInput = z.object({ secret: Text.min(8).max(4096) });
export const PublicModel = z.object({
  id: Text, name: Text, resolvedModel: Text.optional(), capabilities: Text.optional(),
  effortLevels: z.array(z.object({ value: Text, description: Text.optional() })).optional(), defaultEffort: Text.optional(),
});
export const PublicModels = z.object({ models: z.array(PublicModel) });
export const PublicConnectionRefresh = PublicModels.extend({
  // Native refresh returns these fields; API-key refresh returns only models.
  name: Text.optional(), billing: z.object({ mode: z.enum(["subscription", "existing"]), description: Text, provider: Text.optional(), model: Text.nullish() }).optional(),
  capabilities: z.record(Text, z.json()).optional(),
});
export const PublicHarnessCommand = z.object({
  name: Text, token: Text, kind: Text, description: Text,
  argumentHint: Text.optional(), disabledReason: Text.optional(), available: z.boolean().optional(), reason: Text.optional(),
  sourceInfo: z.object({ source: Text.optional(), scope: Text.optional(), origin: Text.optional(), baseDir: Text.optional(), path: Text.optional() }).catchall(z.json()).optional(),
});
export const PublicPiResource = z.object({
  name: Text, description: Text, kind: z.enum(["skill", "prompt", "extension", "tool"]),
  token: Text.optional(), active: z.boolean().optional(), scope: Text.optional(), source: Text.optional(), package: Text.optional(), path: Text.optional(),
});
export const PublicPiInventory = z.object({
  resources: z.array(PublicPiResource), packages: z.array(z.object({ path: Text, name: Text, resources: z.number() })),
  model: z.object({ provider: Text.optional(), id: Text.optional(), name: Text.optional() }).optional(),
  thinkingLevel: Text.optional(), source: Text, toolsTruncated: z.boolean().optional(), projectTrusted: z.boolean().optional(),
  diagnostics: z.array(z.object({ kind: Text, path: Text.optional(), event: Text.optional() })).optional(),
});
export const PublicHarnessCatalog = z.object({
  available: z.boolean(), commands: z.array(PublicHarnessCommand), runtime: Text.optional(), message: Text.optional(),
  // Claude's subscription runtime also includes its model catalog.
  models: z.array(PublicModel).optional(),
  // Runtime catalogs without a session version omit these display fences.
  generation: Text.optional(), revision: z.number().optional(), capabilities: SessionCapabilities.optional(), inventory: PublicPiInventory.optional(),
});
export const PiFilters = z.strictObject({
  extensions: z.array(Text.max(300)).max(100).optional(), skills: z.array(Text.max(300)).max(100).optional(),
  prompts: z.array(Text.max(300)).max(100).optional(), themes: z.array(Text.max(300)).max(100).optional(),
});
export const PublicPiPackage = z.object({
  source: Text, scope: z.enum(["user", "project"]), autoload: z.boolean().optional(),
  filters: z.object({ extensions: z.array(Text).optional(), skills: z.array(Text).optional(), prompts: z.array(Text).optional(), themes: z.array(Text).optional() }),
  settingsHash: Text, previousSource: Text.optional(), resolvedSource: Text.optional(),
});
export const PublicPiConfiguration = z.object({
  project: Text,
  trust: z.object({ required: z.boolean(), trusted: z.boolean(), decision: Text, fingerprint: Text,
    paths: z.array(z.object({ path: Text, kind: Text, size: z.number().optional() })), override: z.boolean().optional(),
  }),
  packages: z.array(PublicPiPackage), instructions: z.array(z.object({ path: Text, role: Text, scope: Text, effective: z.boolean() })),
});
export const PublicPiMutation = PublicPiConfiguration.extend({ status: z.literal("configured"), application: z.literal("new-session") });
export const PublicPiInspection = z.object({
  source: Text, inspected: z.boolean(), resolved: Text.optional(), name: Text.optional(), description: Text.optional(),
  resources: z.record(Text, z.array(Text)), note: Text.optional(),
});
const Source = Text.min(1).max(512), Scope = z.enum(["user", "project"]), Hash = Text.regex(/^[a-f0-9]{64}$/);
export const PiTrustInput = z.strictObject({ trusted: z.boolean(), fingerprint: Hash });
export const PiFiltersInput = z.strictObject({ source: Source, scope: Scope, settingsHash: Hash, filters: PiFilters });
export const PiPreviewInput = z.strictObject({ name: Text.min(1).max(100), args: Text.max(2000), conversation: Text.uuid().optional() });
export const PiInspectInput = z.strictObject({ source: Source });
export const PiRollbackInput = z.strictObject({ source: Source, scope: Scope });
export const PiActionInput = PiRollbackInput.extend({ action: z.enum(["install", "remove", "update"]) });
export const PublicAgentMessages = z.object({
  // Older linked sources omit run/model metadata and may encode final as a boolean.
  items: z.array(z.object({ id: Text, content: Text, created_at: z.number(), conversation_id: Text.nullable(), run_id: Text.nullish(), final: z.union([z.number(), z.boolean()]), model: Text.nullish() })),
  next: Text.nullable(),
});
export const PublicAgentTrace = z.object({
  // These display details were optional in the client before contract migration.
  id: z.number(), owner_id: Text, trace_key: Text.optional(), run_id: Text, kind: Text, title: Text, content: Text, metadata: Text,
  artifact_id: Text.nullable(), created_at: z.number(), input: Text, run_state: Text, run_error: Text.nullish(),
  conversation_id: Text.nullable(), server: Text.nullish(), invocation_state: Text.nullish(),
});
export const PublicAgentTraces = z.object({ items: z.array(PublicAgentTrace), next: z.number().nullable() });
