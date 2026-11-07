import { z } from "zod";
import { FleetGrantContext } from "./fleet.js";
import {
  FleetMailWorkerRequest,
  FleetMailWorkerResponse,
  FleetMailWorkerState,
} from "./fleet-mail-worker.js";
import {
  NativeProvider,
  NativeProviderView,
  ProviderTarget,
  ProviderKey,
  ProviderRemove,
  ProviderRefresh,
} from "./native-providers.js";
import { Harness } from "../protocol.js";
import {
  SessionControls as Controls,
  SessionCapabilities as Capabilities,
} from "./session-controls.js";

// Private execution transport. Browser authorization remains at the HTTP host;
// the authority independently resolves every object against the supplied owner.
// The public HTTP parser accepts 12 MiB. Reserve additional room for the
// private envelope so every accepted API body can cross this boundary.
export const EXECUTION_REQUEST_BYTES = 12 * 1024 * 1024 + 64 * 1024;
// Native frames may contain 8 MiB of commands or models. Catalogs combine
// those frames with derived inventory, so allow expansion without truncation.
export const EXECUTION_RESPONSE_BYTES = 64 * 1024 * 1024;
const Id = z.string().min(1).max(200);
const Path = z.string().min(1).max(4096);
const Empty = z.strictObject({});
const JsonObject = z.record(z.string(), z.json());
const Billing = z.strictObject({
  mode: z.enum(["subscription", "existing"]),
  description: z.string(),
  provider: z.string().optional(),
  // Codex config/read reports an unset default model as null.
  model: z.string().nullish(),
});
const Model = z
  .object({
    id: z.string(),
    name: z.string(),
    resolvedModel: z.string().optional(),
    effortLevels: z
      .array(
        z.strictObject({
          value: z.string(),
          description: z.string().optional(),
        }),
      )
      .optional(),
    defaultEffort: z.string().optional(),
  })
  .catchall(z.json());
const NativeCommand = z.strictObject({
  name: z.string(),
  token: z.string(),
  kind: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  disabledReason: z.string().optional(),
  sourceInfo: z
    .object({
      source: z.string().optional(),
      scope: z.string().optional(),
      origin: z.string().optional(),
      baseDir: z.string().optional(),
      path: z.string().optional(),
    })
    .catchall(z.json())
    .optional(),
});
const Catalog = z.strictObject({
  available: z.boolean(),
  runtime: z.string().optional(),
  commands: z.array(NativeCommand),
  inventory: z.json().optional(),
  revision: z.number().int().nonnegative().optional(),
  capabilities: Capabilities.optional(),
  message: z.string().optional(),
});
export const RuntimeHarness = z.enum([
  "codex",
  "claude",
  "pi",
  "opencode",
  "antigravity",

  "muse",
  "grok",
]);
export const AuthHarness = z.enum([
  "codex",
  "claude",
  "pi",
  "opencode",
  "antigravity",

  "muse",
  "grok",
]);
export const RegistrationOptions = z.strictObject({
  harness: Harness,
  executable: Path,
  project: Path,
  version: z.string().max(100),
  billing: z.enum(["subscription", "existing"]),
  args: z.array(z.string().max(4096)).max(32).optional(),
});
const Enabled = z.strictObject({
  name: Harness,
  billing: Billing,
  models: z.array(Model),
  capabilities: JsonObject,
});
const SignIn = z.strictObject({
  providers: z.array(
    NativeProvider.extend({
      id: Id,
      name: z.string(),
      configured: z.boolean().optional(),
      methods: z.array(
        z.strictObject({
          id: Id,
          label: z.string(),
          type: z.enum(["oauth", "api"]),
        }),
      ),
    }).strict(),
  ),
  attempt: z
    .strictObject({
      id: Id,
      commandId: Id,
      provider: Id,
      method: Id,
      state: z.enum([
        "starting",
        "waiting",
        "complete",
        "failed",
        "cancelled",
        "expired",
      ]),
      expiresAt: z.number(),
      url: z.string().optional(),
      code: z.string().optional(),
      instructions: z.string().optional(),
      prompt: z
        .strictObject({
          id: Id,
          type: z.enum(["text", "secret", "select", "manual_code"]),
          message: z.string(),
          options: z
            .array(z.strictObject({ id: Id, label: z.string() }))
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
const Upgrade = z.strictObject({
  commandId: Id,
  name: RuntimeHarness,
  state: z.enum([
    "running",
    "complete",
    "failed",
    "unconfirmed",
    "restart-required",
  ]),
  message: z.string(),
  version: z.string().optional(),
  previous: z.string().optional(),
  target: z.string().optional(),
});
const UpgradeView = z.strictObject({
  upgrade: Upgrade.nullable(),
  installedVersion: z.string().optional(),
  latestVersion: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  checkedAt: z.number().optional(),
  checkHelp: z.string().optional(),
  canUpgrade: z.boolean().optional(),
  upgradeHelp: z.string().optional(),
});
const Filters = z.strictObject({
  extensions: z.array(z.string().max(300)).max(100).optional(),
  skills: z.array(z.string().max(300)).max(100).optional(),
  prompts: z.array(z.string().max(300)).max(100).optional(),
  themes: z.array(z.string().max(300)).max(100).optional(),
});
const PiMutation = z.strictObject({
  status: z.literal("configured"),
  application: z.literal("new-session"),
});
const Agent = { agentId: Id };
const Package = {
  ...Agent,
  source: z.string().min(1).max(512),
  scope: z.enum(["user", "project"]),
};
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const method = <I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  effect: "none" | "receipt" | "existing" | "session" = "none",
) => ({ input, output, effect });

/** Schemas for both sides of every operation, shared by in-process and IPC. */
export const executionOperations = {
  "runtime.status": method(
    Empty,
    z.strictObject({ nativeProcesses: z.number().int().nonnegative() }),
  ),
  "runtime.list": method(
    z.strictObject({ fresh: z.boolean(), cachedOnly: z.boolean().optional() }),
    z.strictObject({
      computer: z.string(),
      online: z.literal(true),
      runtimes: z.array(
        z.strictObject({
          name: RuntimeHarness,
          backend: z.literal("direct"),
          installed: z.boolean(),
          available: z.boolean(),
          version: z.string().optional(),
          help: z.string(),
          enabled: z.boolean(),
          authentication: z.enum(["previously_verified", "unknown"]),
          billing: z.string().optional(),
          project: z.string().optional(),
        }),
      ),
    }),
  ),
  "runtime.register": method(
    z.strictObject({ options: RegistrationOptions }),
    Enabled,
    "receipt",
  ),
  "runtime.enable": method(
    z.strictObject({
      name: RuntimeHarness,
      projectId: Id,
      billing: z.enum(["subscription", "existing"]),
    }),
    Enabled,
    "receipt",
  ),
  "runtime.refresh": method(z.strictObject({ connectionId: Id }), Enabled),
  "auth.catalog": method(
    z.strictObject({ name: AuthHarness, projectId: Id }),
    SignIn,
  ),
  "provider.catalog": method(ProviderTarget.strict(), NativeProviderView),
  "provider.key": method(ProviderKey.strict(), NativeProviderView, "session"),
  "provider.remove": method(
    ProviderRemove.strict(),
    NativeProviderView,
    "receipt",
  ),
  "provider.refresh": method(
    ProviderRefresh.strict(),
    NativeProviderView,
    "receipt",
  ),
  "auth.status": method(z.strictObject({ name: AuthHarness }), SignIn),
  "auth.start": method(
    z.strictObject({
      name: AuthHarness,
      projectId: Id,
      provider: Id,
      method: z.string().min(1).max(100),
    }),
    SignIn,
    "session",
  ),
  "auth.input": method(
    z.strictObject({
      name: AuthHarness,
      attemptId: z.uuid(),
      promptId: z.uuid(),
      value: z
        .string()
        .min(1)
        .max(16000)
        .regex(/^[^\r\n]+$/),
    }),
    SignIn,
    "session",
  ),
  "auth.cancel": method(
    z.strictObject({ name: AuthHarness, attemptId: z.uuid() }),
    SignIn,
    "session",
  ),
  "upgrade.status": method(
    z.strictObject({ name: RuntimeHarness, check: z.boolean().optional() }),
    UpgradeView,
  ),
  "upgrade.start": method(
    z.strictObject({ name: RuntimeHarness }),
    UpgradeView,
    "existing",
  ),
  "upgrade.dismiss": method(
    z.strictObject({ name: RuntimeHarness }),
    UpgradeView,
    "existing",
  ),
  "upgrade.recover": method(
    z.strictObject({ name: RuntimeHarness, confirmedStopped: z.literal(true) }),
    UpgradeView,
    "existing",
  ),
  "native.answer": method(
    z.strictObject({ decisionId: Id, answer: JsonObject }),
    z.strictObject({ state: z.string() }),
    "existing",
  ),
  "native.controls": method(
    z.strictObject({
      conversationId: z.uuid(),
      cachedOnly: z.boolean().optional(),
    }),
    Controls,
  ),
  "native.setting": method(
    z.strictObject({
      conversationId: z.uuid(),
      setting: Id,
      value: z.union([z.string().max(1000), z.boolean(), z.number()]),
      revision: z.number().int().nonnegative(),
      generation: Id,
    }),
    Controls,
    "receipt",
  ),
  "native.catalog": method(
    z.strictObject({
      ...Agent,
      conversationId: z.uuid().optional(),
      cachedOnly: z.boolean().optional(),
    }),
    Catalog,
  ),
  "pi.trust": method(
    z.strictObject({ ...Agent, trusted: z.boolean(), fingerprint: Hash }),
    Empty,
    "receipt",
  ),
  "pi.filters": method(
    z.strictObject({ ...Package, filters: Filters, settingsHash: Hash }),
    PiMutation,
    "receipt",
  ),
  "pi.preview": method(
    z.strictObject({
      ...Agent,
      name: z.string().min(1).max(100),
      args: z.string().max(2000),
      conversationId: z.uuid().optional(),
    }),
    z.strictObject({ token: z.string(), expanded: z.string() }),
  ),
  "pi.inspect": method(
    z.strictObject({ ...Agent, source: z.string().min(1).max(512) }),
    z.strictObject({
      source: z.string(),
      inspected: z.boolean(),
      resolved: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      resources: z.record(z.string(), z.array(z.string())),
      note: z.string().optional(),
    }),
  ),
  "pi.rollback": method(z.strictObject(Package), PiMutation, "receipt"),
  "pi.action": method(
    z.strictObject({
      ...Package,
      action: z.enum(["install", "remove", "update"]),
    }),
    PiMutation,
    "receipt",
  ),
} as const;
export type ExecutionMethod = keyof typeof executionOperations;
export type ExecutionInput<M extends ExecutionMethod> = z.input<
  (typeof executionOperations)[M]["input"]
>;
export type ExecutionOutput<M extends ExecutionMethod> = z.output<
  (typeof executionOperations)[M]["output"]
>;
export const ExecutionRequest = z.strictObject({
  // Trusted host-to-worker delegation; never accepted from a browser header.
  fleet: FleetGrantContext.optional(),
  v: z.literal(1),
  requestId: z.uuid(),
  generation: z.uuid(),
  owner: Id,
  method: z.enum(
    Object.keys(executionOperations) as [ExecutionMethod, ...ExecutionMethod[]],
  ),
  commandId: Id.optional(),
  input: z.json(),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;
export const ExecutionReady = z.strictObject({
  v: z.literal(1),
  generation: z.uuid(),
  state: z.enum(["starting", "ready", "stopping", "disconnected"]),
});
export const ExecutionResponse = z.discriminatedUnion("ok", [
  z.strictObject({
    v: z.literal(1),
    requestId: z.uuid(),
    generation: z.uuid(),
    ok: z.literal(true),
    result: z.json(),
  }),
  z.strictObject({
    v: z.literal(1),
    requestId: z.uuid(),
    generation: z.uuid(),
    ok: z.literal(false),
    error: z.strictObject({
      status: z.number().int().min(400).max(599),
      message: z.string().max(4000),
      outcome: z.enum(["refused", "unknown", "completed"]),
    }),
  }),
]);
export type ExecutionResponse = z.infer<typeof ExecutionResponse>;

// The inherited IPC channel carries only these envelopes. Lifecycle commands
// are parent-owned and generation-bound; they cannot submit native effects.
export const ExecutionParentMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("fleet-mail-state"),
    state: FleetMailWorkerState,
  }),
  z.strictObject({
    type: z.literal("fleet-mail-response"),
    response: FleetMailWorkerResponse,
  }),
  z.strictObject({ type: z.literal("request"), request: ExecutionRequest }),
  z.strictObject({
    type: z.literal("lifecycle"),
    requestId: z.uuid(),
    generation: z.uuid(),
    action: z.enum(["schedule", "origin", "stop"]),
    origin: z.string().max(4096).optional(),
  }),
]);
export const ExecutionChildMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("fleet-mail-read"),
    request: FleetMailWorkerRequest,
  }),
  z.strictObject({ type: z.literal("ready"), ready: ExecutionReady }),
  z.strictObject({ type: z.literal("response"), response: ExecutionResponse }),
  z.strictObject({
    type: z.literal("ack"),
    requestId: z.uuid(),
    generation: z.uuid(),
    ok: z.boolean(),
  }),
]);
