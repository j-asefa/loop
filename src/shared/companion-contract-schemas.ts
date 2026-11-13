import { ActivityKey } from "./contract-ids.js";
import { NativeGenerationId } from "./contract-ids.js";
import { ModelId } from "./contract-ids.js";
import { ExecutionCommandId } from "./contract-ids.js";
import {
  NativeProviderId,
  AuthMethodId,
  AuthAttemptId,
  AuthPromptId,
  AuthOptionId,
} from "./contract-ids.js";
import { NativeCatalogId, ConversationId } from "./contract-ids.js";
import {
  ProjectId,
  RunId,
  requestId,
  FolderId,
  OwnerId,
} from "./contract-ids.js";
import { NativeSessionState } from "./native-session-state.js";
import { z } from "zod";
import { ActivityKind, ActivityRecordSchema } from "./agent-activities.js";
import { Harness, ItemSchema } from "./protocol.js";
import {
  AuthHarness,
  RuntimeHarness,
  executionOperations,
} from "./execution-authority.js";
import {
  PublicConnectionRefresh,
  PublicModel,
} from "./agent-contract-schemas.js";
import { SessionCapabilities } from "./session-controls.js";
import { NativeProvider } from "./native-providers.js";

const Text = z.string();
export const RuntimeName = z.object({ name: RuntimeHarness });
export const RuntimeAuthName = z.object({ name: AuthHarness });
export const RuntimeAuthStart = executionOperations["auth.start"].input
  .omit({ name: true })
  .extend({
    projectId: requestId(ProjectId).min(1).max(200),
    commandId: requestId(ExecutionCommandId).uuid(),
    provider: requestId(NativeProviderId).min(1).max(200),
    method: requestId(AuthMethodId).min(1).max(100),
  });
export const RuntimeAuthInput = executionOperations["auth.input"].input
  .omit({ name: true })
  .extend({
    attemptId: requestId(AuthAttemptId).uuid(),
    promptId: requestId(AuthPromptId).uuid(),
  });
export const RuntimeAuthCancel = executionOperations["auth.cancel"].input
  .omit({ name: true })
  .extend({ attemptId: requestId(AuthAttemptId).uuid() });
export const PublicRuntimeAuth = z.object({
  providers: z.array(
    NativeProvider.extend({
      id: NativeProviderId,
      name: Text,
      configured: z.boolean().optional(),
      methods: z.array(
        z.object({
          id: AuthMethodId,
          label: Text,
          type: z.enum(["oauth", "api"]),
        }),
      ),
    }),
  ),
  attempt: z
    .object({
      id: AuthAttemptId,
      commandId: ExecutionCommandId,
      provider: NativeProviderId,
      method: AuthMethodId,
      state: z.enum([
        "starting",
        "waiting",
        "complete",
        "failed",
        "cancelled",
        "expired",
      ]),
      expiresAt: z.number(),
      // code is the displayed OAuth user_code, never the secret device_code polling token.
      url: Text.optional(),
      code: Text.optional(),
      instructions: Text.optional(),
      prompt: z
        .object({
          id: AuthPromptId,
          type: z.enum(["text", "secret", "select", "manual_code"]),
          message: Text,
          options: z
            .array(z.object({ id: AuthOptionId, label: Text }))
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
export const CommandIdentity = z.strictObject({
  commandId: requestId(ExecutionCommandId).uuid(),
});
export const UpgradeRecoverInput = CommandIdentity.extend({
  confirmedStopped: z.literal(true),
});
export const RuntimeEnableInput = executionOperations["runtime.enable"].input
  .omit({ name: true })
  .extend({
    projectId: requestId(ProjectId).min(1).max(200),
    commandId: requestId(ExecutionCommandId).uuid().optional(),
  });
export const PublicEnabledRuntime = z.object({
  name: Harness,
  billing: PublicConnectionRefresh.shape.billing.unwrap(),
  models: z.array(PublicModel),
  capabilities: z.record(Text, z.json()),
});
export const PublicWorkspace = z.object({
  harnesses: z.array(PublicEnabledRuntime.extend({ updatedAt: z.number() })),
  nativeProcesses: z.number(),
  concurrency: z.number(),
  hostLifetime: z.literal("foreground"),
  tunnelOrigin: Text,
  projectPaths: z.array(z.object({ folder_id: FolderId, path: Text })),
});
export const PublicRuntimes = z.object({
  computer: Text,
  online: z.literal(true),
  setup: z.enum([
    "idle",
    "preparing",
    "starting",
    "ready",
    "failed",
    "stopped",
  ]),
  runtimes: z.array(
    z.object({
      name: RuntimeHarness,
      backend: z.literal("direct"),
      installed: z.boolean(),
      available: z.boolean(),
      version: Text.optional(),
      help: Text,
      enabled: z.boolean(),
      authentication: Text,
      billing: Text.optional(),
      project: Text.optional(),
    }),
  ),
});
const PublicUpgrade = z.object({
  commandId: ExecutionCommandId,
  name: RuntimeHarness,
  state: z.enum([
    "running",
    "complete",
    "failed",
    "unconfirmed",
    "restart-required",
  ]),
  message: Text,
  version: Text.optional(),
  previous: Text.optional(),
  target: Text.optional(),
});
export const PublicUpgradeView = z.object({
  upgrade: PublicUpgrade.nullable(),
  // Only the status producer supplies discovery help; mutation responses do not.
  installedVersion: z.string().optional(),
  latestVersion: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  checkedAt: z.number().optional(),
  checkHelp: z.string().optional(),
  canUpgrade: z.boolean().optional(),
  upgradeHelp: Text.optional(),
});
export const ProjectCreateInput = z.object({
  path: Text.min(1).max(4096),
  name: Text.trim().min(1).max(100).optional(),
});
export const ProjectUpdateInput = ProjectCreateInput.pick({ path: true });
const CreatedProject = z.object({
  id: ProjectId,
  name: Text,
  kind: z.literal("project"),
  path: Text,
});
// Reusing an existing project returns its public folder fields as well.
export const PublicProject = z.union([
  CreatedProject.extend({
    owner_id: OwnerId,
    parent_id: FolderId.nullable(),
    created_at: z.number(),
  }),
  CreatedProject,
]);
export const PublicNativeConversation = z.object({
  // Conversations without a native binding still have an empty display projection.
  binding: z
    .object({
      harness: Harness,
      project: Text,
      model: ModelId.nullable(),
      state: NativeSessionState,
      updated_at: z.number(),
    })
    .optional(),
  memoryIncluded: z.boolean(),
  items: z.array(ItemSchema),
  projection: z.literal(true),
  note: Text,
});
const HistoryEntry = z.object({
  id: Text,
  harness: Harness,
  project: Text,
  title: Text,
});
export const PublicNativeHistory = z.object({
  managed: z.array(HistoryEntry.extend({ id: ConversationId, state: Text })),
  external: z.array(HistoryEntry.extend({ id: NativeCatalogId })),
  next: Text.nullable(),
  // The non-discovery branch has no external-history note.
  note: Text.optional(),
});
export const PublicNativeHistoryDetail = z.object({
  items: z.array(ItemSchema),
  note: Text,
  activities: z.array(
    z.object({
      key: ActivityKey,
      kind: ActivityKind,
      record: ActivityRecordSchema,
    }),
  ),
});
const ActivityRunIds = z.array(RunId.min(1).max(150)).min(1).max(50);
export const ActivityQuery = z.object({
  after: z.coerce.number<string>().int().nonnegative().optional(),
  run: requestId(RunId).max(100).optional(),
  before: z.coerce
    .number<string>()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  view: z.enum(["recent", "updates", "files"]).optional(),
  tools: z.enum(["0", "1"]).optional(),
  // Keep the wire shape a string in both the registry and OpenAPI parameters.
  runs: Text.max(7600)
    .refine((value) => ActivityRunIds.safeParse(value.split(",")).success)
    .describe("Comma-separated run IDs: 1–50 IDs, each 1–150 characters.")
    .optional(),
});
const PublicActivityItem = z.object({
  key: ActivityKey,
  kind: z.enum([...ActivityKind.options, "capabilities"]),
  run: RunId.nullable(),
  sequence: z.number(),
  // Only synthesized pre-activity traces carry this marker.
  record: z.union([
    ActivityRecordSchema,
    z.object({
      v: z.literal(1),
      kind: z.literal("capabilities"),
      source: z.object({ transport: Text, harness: Text.optional() }),
      generation: NativeGenerationId.optional(),
      capabilities: z.record(
        SessionCapabilities.keyType,
        SessionCapabilities.valueType.strip(),
      ),
    }),
  ]),
});
export const PublicActivityPage = z.object({
  version: z.literal(1),
  items: z.array(PublicActivityItem),
  cursor: z.number(),
  more: z.boolean(),
  // Forward-paged sources before 853f9afc omit on-demand history metadata.
  earlier: z.number().nullable().optional(),
});
