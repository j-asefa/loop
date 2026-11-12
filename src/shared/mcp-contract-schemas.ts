import { McpConnectionStatus } from "./mcp-status.js";
import { z } from "zod";
import { toolInvocationSchema } from "./artifact-refresh.js";
import { PERMISSION_MODES } from "./permission-modes.js";

const Text = z.string(),
  Count = z.number();
const Permission = z.enum(PERMISSION_MODES.map((mode) => mode.value));
export const PublicAgentSources = z.array(
  z.object({ id: Text, name: Text, kind: Text }),
);
export const McpPreferencesInput = z
  .strictObject({
    approvalMode: z.enum(["ask", "allow"]).optional(),
    agentPermissionMode: Permission.optional(),
  })
  .refine(
    (value) =>
      value.approvalMode !== undefined ||
      value.agentPermissionMode !== undefined,
    "Choose a preference to change",
  );
export const PublicMcpPreferences = z.object({
  approvalMode: z.enum(["ask", "allow"]),
  agentPermissionMode: Permission,
});
export const McpCatalogInput = z.strictObject({
  values: z.record(Text.max(100), Text.max(10000)).default({}),
});
// Strict: a destination field such as runtimeHostId is refused, never dropped
// into a local command install.
export const McpInstallInput = z.strictObject({
  config: z.union([Text.max(50000), z.record(Text, z.unknown())]),
  agentId: Text.optional(),
});
// Request-only setup values, never the encrypted credential/storage shape.
const AuthInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("oauth") }),
  z.object({ type: z.literal("bearer"), token: Text.min(1).max(10000) }),
  z.object({
    type: z.literal("headers"),
    headers: z
      .record(Text.regex(/^[A-Za-z0-9_-]{1,80}$/), Text.min(1).max(10000))
      .refine(
        (headers) =>
          Object.keys(headers).length <= 8 &&
          !Object.keys(headers).some((key) =>
            /^(host|cookie|origin|referer|connection|content-length|transfer-encoding|proxy-.*|sec-.*)$/i.test(
              key,
            ),
          ),
        "Unsupported authentication header",
      ),
  }),
]);
export const McpCreateInput = z.object({
  name: Text.trim().min(1).max(80),
  url: Text.max(2000),
  auth: AuthInput,
});
export const McpUpdateInput = z.object({
  action: z.enum(["disable", "enable", "disconnect", "credentials"]),
  auth: AuthInput.optional(),
});
export const McpToolCallInput = toolInvocationSchema.extend({
  idempotencyKey: Text.min(10).max(200),
});
export const PublicMcpConnection = z.object({
  id: Text,
  owner_id: Text,
  name: Text,
  url: Text,
  status: McpConnectionStatus,
  tools: Text,
  metadata: Text,
  created_at: Count,
  authType: z.enum(["none", "bearer", "headers", "oauth", "query"]),
});
export const PublicMcpTest = z.union([
  PublicMcpConnection,
  z.object({ result: Text, authorizationUrl: Text }),
]);
export const PublicMcpCandidates = z.array(
  z.object({
    id: Text,
    provider: Text,
    name: Text,
    kind: z.enum(["command", "http"]),
  }),
);
export const PublicMcpInstall = z.array(
  z.union([
    z.object({
      id: Text,
      name: Text,
      status: z.literal("connected"),
      tools: Count,
    }),
    z.object({
      id: Text,
      name: Text,
      status: z.enum(["disabled", "needs_auth"]),
      error: Text,
    }),
  ]),
);
export const PublicMcpCatalog = z.object({
  entries: z.array(
    z.object({
      id: Text,
      name: Text,
      publisher: Text,
      category: Text,
      description: Text,
      source: Text,
      auth: z.enum(["none", "oauth", "bearer", "query", "oauth-app", "env"]),
      inputs: z.array(
        z.object({ key: Text, label: Text, secret: z.boolean() }),
      ),
      // Catalog entries without a publisher note omit it; stdio has no server URL.
      note: Text.optional(),
      transport: z.enum(["http", "stdio"]),
      serverUrl: Text.optional(),
    }),
  ),
  reviewedAt: Text,
  oauthRedirectUrl: Text,
});
export const PublicMcpCatalogInstall = z.union([
  z.object({ id: Text, status: z.literal("connected"), tools: Count }),
  z.object({
    id: Text,
    status: z.literal("needs_auth"),
    tools: Count,
    authorizationUrl: Text,
  }),
  z.object({
    id: Text,
    status: z.enum(["disabled", "needs_auth"]),
    tools: Count,
    error: Text,
  }),
]);
