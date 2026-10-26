import { z } from "zod";
import { ActivityKind, ActivityRecordSchema } from "../agent-activities.js";
import { Harness, ItemSchema } from "../protocol.js";
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

const Text = z.string();
export const RuntimeName = z.object({ name: RuntimeHarness });
export const RuntimeAuthName = z.object({ name: AuthHarness });
export const RuntimeAuthStart = executionOperations["auth.start"].input
  .omit({ name: true })
  .extend({ commandId: Text.uuid() });
export const RuntimeAuthInput = executionOperations["auth.input"].input.omit({
  name: true,
});
export const RuntimeAuthCancel = executionOperations["auth.cancel"].input.omit({
  name: true,
});
export const PublicRuntimeAuth = z.object({
  providers: z.array(
    z.object({
      id: Text,
      name: Text,
      configured: z.boolean().optional(),
      methods: z.array(
        z.object({ id: Text, label: Text, type: z.enum(["oauth", "api"]) }),
      ),
    }),
  ),
  attempt: z
    .object({
      id: Text,
      // Sources before 231973a9 omit start-command identity; absence cannot resolve a lost start.
      commandId: Text.optional(),
      provider: Text,
      method: Text,
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
          id: Text,
          type: z.enum(["text", "secret", "select", "manual_code"]),
          message: Text,
          options: z.array(z.object({ id: Text, label: Text })).optional(),
        })
        .optional(),
    })
    .optional(),
});
export const CommandIdentity = z.strictObject({ commandId: Text.uuid() });
export const UpgradeRecoverInput = CommandIdentity.extend({
  confirmedStopped: z.literal(true),
});
export const RuntimeEnableInput = executionOperations["runtime.enable"].input
  .omit({ name: true })
  .extend({ commandId: Text.uuid().optional() });
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
  projectPaths: z.array(z.object({ folder_id: Text, path: Text })),
});
export const PublicRuntimes = z.object({
  computer: Text,
  online: z.literal(true),
  // Discovery before 922d849d did not report setup lifecycle metadata.
  setup: z
    .enum(["idle", "preparing", "starting", "ready", "failed", "stopped"])
    .optional(),
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
export const PublicUpgrade = z.object({
  commandId: Text,
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
  canUpgrade: z.boolean().optional(),
  upgradeHelp: Text.optional(),
});
export const ProjectCreateInput = z.object({
  path: Text.min(1).max(4096),
  name: Text.trim().min(1).max(100).optional(),
});
export const ProjectUpdateInput = ProjectCreateInput.pick({ path: true });
const CreatedProject = z.object({
  id: Text,
  name: Text,
  kind: z.literal("project"),
  path: Text,
});
// Reusing an existing project returns its public folder fields as well.
export const PublicProject = z.union([
  CreatedProject.extend({
    owner_id: Text,
    parent_id: Text.nullable(),
    created_at: z.number(),
  }),
  CreatedProject,
]);
export const PublicNativeItem = ItemSchema.extend({
  phase: z.enum(["commentary", "final_answer"]).optional(),
});
export const PublicNativeConversation = z.object({
  // Conversations without a native binding still have an empty display projection.
  binding: z
    .object({
      harness: Harness,
      project: Text,
      model: Text.nullable(),
      state: Text,
      updated_at: z.number(),
    })
    .optional(),
  memoryIncluded: z.boolean(),
  items: z.array(PublicNativeItem),
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
  managed: z.array(HistoryEntry.extend({ state: Text })),
  external: z.array(HistoryEntry),
  next: Text.nullable(),
  // The non-discovery branch has no external-history note.
  note: Text.optional(),
});
export const PublicNativeHistoryDetail = z.object({
  items: z.array(PublicNativeItem),
  note: Text,
  // Native history before d124e8c9 predates structured activity projections.
  activities: z
    .array(
      z.object({ key: Text, kind: ActivityKind, record: ActivityRecordSchema }),
    )
    .optional(),
});
const ActivityRunIds = z.array(Text.min(1).max(150)).min(1).max(50);
export const ActivityQuery = z.object({
  after: z.coerce.number<string>().int().nonnegative().optional(),
  run: Text.max(100).optional(),
  before: z.coerce
    .number<string>()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  view: z.enum(["recent", "updates", "legacy", "files"]).optional(),
  tools: z.enum(["0", "1"]).optional(),
  // Keep the wire shape a string in both the registry and OpenAPI parameters.
  runs: Text.max(7600)
    .refine((value) => ActivityRunIds.safeParse(value.split(",")).success)
    .describe("Comma-separated run IDs: 1–50 IDs, each 1–150 characters.")
    .optional(),
});
export const PublicActivityItem = z.object({
  key: Text,
  kind: z.enum([...ActivityKind.options, "capabilities"]),
  run: Text.nullable(),
  sequence: z.number(),
  // Only synthesized pre-activity traces carry this marker.
  legacy: z.boolean().optional(),
  record: z.union([
    ActivityRecordSchema,
    z.object({
      v: z.literal(1),
      kind: z.literal("capabilities"),
      source: z.object({ transport: Text, harness: Text.optional() }),
      generation: Text.optional(),
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
  legacyAvailable: z.boolean().optional(),
});
export const RuntimeHostCreateInput = z.object({
  name: Text.trim().min(1).max(80),
  url: Text.url().max(2000),
  token: Text.trim()
    .min(32)
    .max(4096)
    .regex(/^[^\r\n]+$/),
  kind: z.enum(["broker", "codex-app-server", "native-host"]).default("broker"),
});
export const PublicRuntimeHost = z.object({
  id: Text,
  name: Text,
  url: Text,
  kind: z.enum(["broker", "codex-app-server", "native-host", "local"]),
});

export const SubscriptionCreateInput = z.object({
  provider: z.enum(["codex", "claude"]),
  label: Text.trim().min(1).max(80),
  runtimeHostId: Text.optional(),
});

export const SubscriptionActionParams = z.object({
  id: Text,
  action: z.enum(["login", "status", "code", "cancel"]),
});
// Non-code actions historically ignore their bodies; validate code only in that branch.
export const SubscriptionCodeInput = z.object({
  code: Text.trim()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n]+$/),
});
const RateWindow = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
});
const RateLimit = z.object({
  limitId: Text.nullish(),
  limitName: Text.nullish(),
  planType: Text.nullish(),
  primary: RateWindow.nullish(),
  secondary: RateWindow.nullish(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: Text.nullish(),
    })
    .nullish(),
});
const PublicLimits = z.object({
  rateLimits: RateLimit,
  rateLimitsByLimitId: z.record(Text, RateLimit).nullish(),
});
const SubscriptionStatus = z.object({
  authenticated: z.literal(true),
  authMode: z.literal("subscription"),
  models: z.array(PublicModel),
  plan: Text.nullish(),
  limits: PublicLimits.nullish(),
  state: z.literal("completed").optional(),
});
// The pre-contract client and broker fixtures accept an absent display expiry.
// Its absence never confirms authentication or changes the broker's deadline.
const SubscriptionExpiry = z.number().optional();
export const PublicSubscriptionAction = z.union([
  SubscriptionStatus,
  z.object({
    authenticated: z.literal(false),
    authMode: z.literal("none").optional(),
    models: z.array(PublicModel).optional(),
    plan: Text.nullish(),
    state: z.literal("completed").optional(),
  }),
  z.object({
    state: z.enum(["starting", "waiting"]),
    expiresAt: SubscriptionExpiry,
    login: z
      .object({ url: Text, code: Text.optional(), acceptsCode: z.boolean() })
      .optional(),
  }),
  z.object({
    state: z.enum(["failed", "cancelled"]),
    expiresAt: SubscriptionExpiry,
    error: Text.optional(),
  }),
  z.object({ state: z.literal("busy") }),
  z.object({ ok: z.literal(true) }),
  PublicEnabledRuntime,
]);
