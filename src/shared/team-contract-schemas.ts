import { MAX_TEAM_WORKERS } from "./team-limits.js";
import { z } from "zod";
import { AgentHandle, AgentInput } from "./agent-contract-schemas.js";
import { MAX_DEFINITION_BYTES } from "./agent-definitions.js";
import { ProviderSchema } from "./provider-schema.js";

const Text = z.string(),
  Time = z.number();
export const TeamCreateInput = z.object({
  name: Text.trim().min(1).max(80),
  managerId: Text,
  members: z.array(Text).min(1).max(MAX_TEAM_WORKERS),
});
const Selection = z.object({
  connectionId: Text,
  model: Text.min(1),
  effort: Text.nullable().optional(),
});
export const TeamPresetInput = z.object({
  presetId: Text,
  name: Text.trim().min(1).max(80),
  folderId: Text.min(1),
  selection: Selection,
  roles: z.record(Text, Selection).default({}),
  idempotencyKey: Text.min(8).max(150),
});
export const PublicTeamPreset = z.object({
  id: Text,
  version: z.number(),
  name: Text,
  description: Text,
  roles: z.array(z.object({ id: Text, name: Text, instructions: Text })),
});
export const ReviewInput = z.object({
  folderId: Text.min(1),
  scope: z.enum(["uncommitted", "staged", "branch"]),
  base: Text.trim().min(1).max(200).default("main"),
  idempotencyKey: Text.min(8).max(150),
});
// HTTP uses id; the agent tool exposes the same identity as reviewId.
export const PublicReview = z.object({
  id: Text,
  conversationId: Text,
  state: Text,
  scope: z.enum(["uncommitted", "staged", "branch"]),
  fingerprint: Text,
  createdAt: Time,
  changed: z.array(Text),
  omitted: z.array(Text),
  reviewers: z.array(
    z.object({
      agent_id: Text.nullable(),
      state: Text,
      error: Text.nullable(),
    }),
  ),
  current: z.boolean().nullable(),
  freshnessError: Text.nullable(),
});

export const DefinitionSaveInput = z.strictObject({
  // Keep the original Markdown; frontmatter and UTF-8 byte limits belong to parseDefinition.
  markdown: Text.max(MAX_DEFINITION_BYTES),
  version: z.number().int().nonnegative(),
  kind: z.enum(["agent", "team"]).optional(),
});
const DefinitionChoice = z.strictObject({
  connectionId: Text.min(1),
  model: AgentInput.shape.model.optional(),
  effort: AgentInput.shape.effort,
});
export const DefinitionVersion = z.number().int().positive();
export const DefinitionCreateInput = z.strictObject({
  version: DefinitionVersion,
  selection: DefinitionChoice,
  folderId: Text.min(1).nullable().optional(),
  teamId: Text.min(1).optional(),
  name: Text.trim().min(1).max(80).optional(),
  roles: z
    .record(
      Text,
      DefinitionChoice.partial()
        .extend({ name: AgentHandle.optional() })
        .strict(),
    )
    .default({}),
  idempotencyKey: Text.min(8).max(150),
});
const PublicDefinitionRole = z.object({
  name: Text,
  description: Text,
  instructions: Text,
  // Definition metadata has always allowed provider defaults for model and effort.
  model: Text.optional(),
  effort: Text.nullable().optional(),
});
const PublicDefinitionSpec = z.discriminatedUnion("kind", [
  PublicDefinitionRole.extend({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("team"),
    name: Text,
    description: Text,
    manager: PublicDefinitionRole,
    members: z.array(PublicDefinitionRole),
  }),
]);
export const PublicDefinitionSummary = z.object({
  id: Text,
  kind: z.enum(["agent", "team"]),
  name: Text,
  description: Text,
  version: z.number(),
  created_at: Time,
  updated_at: Time,
});
export const PublicDefinition = PublicDefinitionSummary.extend({
  markdown: Text,
  spec: PublicDefinitionSpec,
});

export const SharedSource = z.object({
  url: Text.max(3000).refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Use an HTTP or HTTPS source link"),
  title: Text.max(300).default(""),
  excerpt: Text.max(12000).default(""),
});
export const ShareInput = z.object({
  question: Text.trim().min(1).max(20000),
  source: SharedSource.optional(),
  sharedText: Text.max(12000).optional(),
  folderId: Text.optional(),
});
export const ShareSendInput = ShareInput.extend({
  newAgentId: Text.optional(),
  idempotencyKey: Text.min(10).max(150),
});
export const RoutingInput = z.object({
  input: Text.min(1).max(30000),
  folderId: Text.optional(),
});
export const PublicSharePreview = z.object({
  mode: z.enum(["queue", "create"]),
  agent: z
    .object({
      id: Text,
      name: Text,
      provider: ProviderSchema,
      model: Text,
      effort: Text.nullable(),
    })
    .nullable(),
  // A source is returned only when the request included a link.
  source: z.object({ url: Text, title: Text, excerpt: Text }).optional(),
});

export function pushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (url.hostname === "fcm.googleapis.com" ||
        url.hostname === "updates.push.services.mozilla.com" ||
        url.hostname.endsWith(".push.apple.com") ||
        url.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}
export const PushEndpoint = Text.max(4096).refine(
  pushEndpoint,
  "Unsupported phone notification service",
);
export const NotificationPreferences = z.object({
  needsYou: z.boolean(),
  completed: z.boolean(),
  reminders: z.boolean(),
  social: z.boolean(),
});
// Browser-issued Web Push keys are input only. Never reuse this in a response.
export const PushSubscription = z.object({
  endpoint: PushEndpoint,
  keys: z.object({
    p256dh: Text.regex(/^[A-Za-z0-9_-]{87}=?$/).refine((value) => {
      try {
        const key = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
        return key.length === 65 && key.charCodeAt(0) === 4;
      } catch {
        return false;
      }
    }),
    auth: Text.regex(/^[A-Za-z0-9_-]{22}(==)?$/),
  }),
});
export const NotificationSubscriptionInput = PushSubscription.extend({
  preferences: NotificationPreferences.optional(),
});
export const PublicNotifications = z.object({
  publicKey: Text,
  endpoints: z.array(Text),
  devices: z.array(
    z.object({ endpoint: Text, preferences: NotificationPreferences }),
  ),
});

const Geometry = z.number().finite().min(-1e9).max(1e9);
const Rect = z.union([
  z.array(Geometry).length(0),
  z.array(Geometry).length(4),
]);
const ViewportSample = z.strictObject({
  elapsed: Geometry,
  viewport: z.array(Geometry).length(9),
  dialog: Rect,
  header: Rect,
  input: Rect,
  body: Rect,
  flags: z.array(Geometry).length(8),
});
export const ViewportInput = z.strictObject({
  session: Text.uuid(),
  samples: z.array(ViewportSample).min(1).max(8),
});
