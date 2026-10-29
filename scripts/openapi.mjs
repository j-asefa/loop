import { SCOPE_CATALOG, isTokenMutation } from "../src/shared/token-scopes.ts";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  workspaceRoutes,
  CardErrorSchema,
  PublicAgent,
  PublicConnection,
  PublicFolder,
  PublicTeam,
  PublicMessage,
  PublicArtifact,
  PublicRun,
  ResultItem,
} from "../src/shared/workspace-api.ts";
import {
  PublicRuntimeAuth,
  PublicUpgradeView,
  PublicEnabledRuntime,
} from "../src/shared/companion-contract-schemas.ts";
import { ActivityRecordSchema } from "../src/agent-activities.ts";
import { DoneDisplaySchema } from "../src/shared/done-card.ts";
import { AgentThreadSummary } from "../src/shared/agent-thread-feed.ts";
import { PublicMailMessage } from "../src/shared/agent-mail.ts";
import { PublicMcpConnection } from "../src/shared/mcp-contract-schemas.ts";
import { PublicReview } from "../src/shared/team-contract-schemas.ts";
import { WorkspaceClock } from "../src/shared/workspace-events.ts";
import {
  ResultCardSchema,
  MessageCardSchema,
  CardSchema,
  CardEntrySchema,
  DoneCardSchema,
} from "../src/shared/cards.ts";
import { CardTokenSchema } from "../src/shared/card-access.ts";
import {
  PublicSocialStory,
  PublicFeedEntry,
  PublicPreferences,
  PublicWatch,
  PublicDigest,
} from "../src/shared/social-contract-schemas.ts";
import {
  SessionControls,
  SessionCapabilities,
} from "../src/shared/session-controls.ts";
import {
  PublicAwayItem,
  PublicLaterView,
  PublicScheduledSend,
  PublicUploadDescriptor,
} from "../src/shared/mobile-contract-schemas.ts";
import { NativeProviderView } from "../src/shared/native-providers.ts";
import {
  PublicPiConfiguration,
  PublicPiMutation,
  PublicPiPackage,
  PublicModel,
} from "../src/shared/agent-contract-schemas.ts";
// Request schemas describe accepted input (including transforms); responses
// describe projected output. Both are populated only from workspaceApi.
const registry = z.registry(),
  inputs = z.registry();
// These published component names survive the registry merge. Operation IDs
// follow workspaceApi's stable keys; this map is only a schema-name alias.
const cardNames = {
  cardList: "list",
  cardChanges: "changes",
  cardDetail: "detail",
  cardTokens: "tokens",
  cardTokenCreate: "createToken",
  cardTokenRevoke: "revokeToken",
};
const schemaName = (name) => cardNames[name] ?? name;
const noBody = (body) => body instanceof z.ZodUndefined;
const jsonOptions = {
  target: "draft-2020-12",
  // No JSON value satisfies NoBody. Keep its registered schema explicit while
  // omitting requestBody from the operation; other unsupported schemas fail.
  unrepresentable: ({ zodSchema }) =>
    zodSchema instanceof z.ZodUndefined ? { not: {} } : "throw",
};
// Reuse the actual public projections instead of copying them into every
// endpoint. Stable per-route response names remain references to these schemas.
const publicProjections = {
  Ok: workspaceRoutes.workspaceRevoke.response,
  PublicActivitySource: ActivityRecordSchema.options[0].shape.source,
  WorkspaceClock,
  PublicMcpConnection,
  PublicReview,
  PublicEnabledRuntime,
  PublicBilling: PublicEnabledRuntime.shape.billing,
  CardSource: DoneCardSchema.shape.source,
  CardAuthor: DoneCardSchema.shape.author,
  CardContext: DoneCardSchema.shape.context,
  CardAttachment: DoneCardSchema.shape.attachments.element,
  SessionCapabilities,
  PublicConversation: workspaceRoutes.conversation.response.shape.conversation,
  PublicDoneCheckout: DoneDisplaySchema.shape.run
    .unwrap()
    .shape.checkout.unwrap(),
  PublicDoneVerification: DoneDisplaySchema.shape.run
    .unwrap()
    .shape.verification.unwrap(),
  DoneCard: DoneCardSchema,
  ResultItem,
  PublicUploadDescriptor,
  PublicAwayItem,
  PublicLaterView,
  SessionControls,
  PublicScheduledSend,
  NativeProviderView,
  PublicPiConfiguration,
  PublicPiMutation,
  PublicPiPackage,
  PublicModel,
  AgentThreadSummary,
  PublicMailMessage,
  PublicAgent,
  PublicConnection,
  PublicFolder,
  PublicTeam,
  PublicMessage,
  PublicArtifact,
  PublicRun,
  PublicSocialStory,
  PublicFeedEntry,
  PublicPreferences,
  PublicWatch,
  PublicDigest,
};
const publicResponses = new Set([
  ...Object.values(publicProjections),
  PublicRuntimeAuth,
  PublicUpgradeView,
  ActivityRecordSchema,
]);
for (const [id, schema] of Object.entries({
  ...publicProjections,
  ResultCard: ResultCardSchema,
  MessageCard: MessageCardSchema,
  Card: CardSchema,
  CardEntry: CardEntrySchema,
  CardToken: CardTokenSchema,
  Error: CardErrorSchema,
  // Both native history and activity pages use this canonical projection.
  ActivityRecord: ActivityRecordSchema,
  RuntimeAuth: PublicRuntimeAuth,
  RuntimeUpgrade: PublicUpgradeView,
}))
  registry.add(schema, { id });
for (const [name, route] of Object.entries(workspaceRoutes)) {
  const prefix = schemaName(name);
  // Clones give shared Empty/NoBody and repeated responses distinct IDs.
  // Cards response identities retain their existing inter-component references.
  registry.add(
    route.kind === "stream"
      ? z.string().meta({ format: "binary" })
      : route.kind === "transport"
        ? z.unknown()
        : cardNames[name]
          ? route.response
          : publicResponses.has(route.response)
            ? z.lazy(() => route.response)
            : route.response.clone(),
    { id: prefix + "Response" },
  );
  inputs.add(route.params.clone(), { id: prefix + "Params" });
  inputs.add(route.query.clone(), { id: prefix + "Query" });
  inputs.add(
    route.multipart
      ? route.body.extend({ file: z.string().meta({ format: "binary" }) })
      : route.body.clone(),
    { id: prefix + "Body" },
  );
}
function registeredSchemas(registry, io, sharedId) {
  const { schemas } = z.toJSONSchema(registry, {
    ...jsonOptions,
    io,
    uri: (id) => "#/components/schemas/" + (id === "__shared" ? sharedId : id),
  });
  // Zod uses a shared resource for recursive JSON. Give input/output resources
  // distinct names and turn resource fragments into document JSON pointers.
  if (schemas.__shared) {
    schemas[sharedId] = schemas.__shared;
    delete schemas.__shared;
  }
  function references(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string")
      value.$ref = value.$ref.replace(
        /^(#\/components\/schemas\/[^#]+)#\//,
        "$1/",
      );
    for (const child of Object.values(value)) references(child);
  }
  for (const schema of Object.values(schemas)) {
    delete schema.$schema;
    delete schema.$id;
    references(schema);
  }
  return schemas;
}
const schemas = {
  ...registeredSchemas(registry, "output", "ResponseShared"),
  ...registeredSchemas(inputs, "input", "RequestShared"),
};
// Keep published component names, but make identical schemas aliases. Repeated
// route inputs and projections otherwise inflate the document without adding
// contract information. Only alias when the reference is smaller.
const canonicalSchemas = new Map();
for (const [name, schema] of Object.entries(schemas)) {
  const encoded = JSON.stringify(schema);
  const canonical = canonicalSchemas.get(encoded);
  const alias = { $ref: "#/components/schemas/" + canonical };
  if (
    canonical &&
    encoded.length > 100 &&
    JSON.stringify(alias).length < encoded.length
  )
    schemas[name] = alias;
  else if (!canonical) canonicalSchemas.set(encoded, name);
}
const responses = {};
const paths = {};
// Share standard errors by route family. Cards reads retain their
// published operation objects, including route-specific errors.
const sharedErrorGroups = new Set([
  "memory",
  "workflows",
  "capabilities",
  "health",
  "build",
  "diagnostic",
  "events",
  "auth-options",
  "auth",
  "mcp",
  "pr-watches",
  "github",
  "social",
  "teams",
  "team-presets",
  "reviews",
  "agent-definitions",
  "share",
  "routing",
  "notifications",
  "agents",
  "artifacts",
  "mcp-sharing",
  "agent-sources",
  "workspace",
  "runtime-hosts",
  "conversations",
  "runs",
  "connections",
  "me",
  "native",
  "later",
  "scheduled-sends",
  "messages",
  "imports",
  "results",
  "feed",
  "folders",
  "subscriptions",
  "saved",
  "projects",
  "search",
  "preferences",
  "approvals",
  "ui",
  "replies",
  "snippets",
  "uploads",
  "operations",
  "objects",
  "bootstrap",
  "card-tokens",
]);
for (const [name, route] of Object.entries(workspaceRoutes)) {
  const path = "/api" + route.path.replace(/[:*]([^/]+)/g, "{$1}");
  // OpenAPI has no ALL verb. Document the protocol's POST entrypoint and mark
  // its delegated method dispatch explicitly, without inventing registry keys.
  const method = route.method === "ALL" ? "post" : route.method.toLowerCase();
  const transport = route.kind === "transport";
  const writes = method !== "get";
  const admission =
    typeof route.access === "object" ? route.access.admits : undefined;
  const tokenMutation = isTokenMutation(route);
  const cardRead =
    admission?.includes("results:read") || admission?.includes("cards:read");
  const prefix = schemaName(name);
  const parameters = [];
  if (tokenMutation)
    parameters.push({ $ref: "#/components/parameters/IntegrationWriteOrigin" });
  else if (writes && !transport)
    parameters.push({
      name: "Origin",
      in: "header",
      required: true,
      schema: { type: "string", format: "uri" },
      description:
        "Required for all management writes and must match the workspace origin. Browsers supply this header automatically.",
    });
  if (route.query) {
    const query = z.toJSONSchema(route.query, jsonOptions);
    const input = z.toJSONSchema(route.query, {
      ...jsonOptions,
      io: "input",
    });
    for (const [key, schema] of Object.entries(query.properties || {}))
      parameters.push({
        name: key,
        in: "query",
        required: input.required?.includes(key) || false,
        schema,
      });
  }
  if (route.security === "local-setup")
    parameters.push({
      name: "x-loop-source-setup",
      in: "header",
      required: true,
      schema: { type: "string", const: "1" },
      description:
        "Local single-user execution-source setup only; paired browser proxies cannot forward this header.",
    });
  const params = z.toJSONSchema(route.params, jsonOptions);
  for (const [key, schema] of Object.entries(params.properties || {}))
    parameters.push({ name: key, in: "path", required: true, schema });
  for (const match of route.path.matchAll(/\*([^/]+)/g))
    parameters.push({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
      description: "Protocol-owned path, including slash-separated segments.",
    });
  const response = {
    description:
      route.status === 302
        ? "Browser redirect to the Location header"
        : "Successful response",
    ...(route.status === 302
      ? {
          headers: {
            Location: {
              description: "Browser redirect destination",
              schema: { type: "string" },
            },
          },
        }
      : {}),
    ...(route.status === 204 || route.status === 302
      ? {}
      : {
          content: {
            [route.kind === "stream"
              ? (route.contentType ?? "application/octet-stream")
              : "application/json"]: {
              schema: { $ref: "#/components/schemas/" + prefix + "Response" },
            },
          },
        }),
  };
  const errorStatuses = [400, 401, 403, 429, 500];
  if (cardRead) errorStatuses.push(404);
  if (name === "cardChanges" || name === "cardTokenCreate" || tokenMutation)
    errorStatuses.push(409);
  if (name === "cardTokenRevoke" || name === "personalApproval")
    errorStatuses.push(404);
  if (name === "tokenEvents") errorStatuses.push(503);
  const errors = Object.fromEntries(
    errorStatuses
      .sort((a, b) => a - b)
      .map((status) => [
        status,
        {
          description: {
            400: "Invalid request",
            401: "Invalid credential or expired session",
            403: "Insufficient scope or origin refused",
            404:
              name === "cardTokenRevoke"
                ? "Token not found for this owner"
                : name === "personalApproval"
                  ? "Approval history not found for this owner"
                  : "Card or selected object not available",
            409:
              name === "cardTokenCreate"
                ? "Creation conflict, revoked identity or secret, or active-token limit"
                : "Cursor no longer valid; reset selection",
            429: "Request limit reached",
            500: "Server error",
            503: "Server shutting down",
          }[status],
          ...(status === 429
            ? {
                headers: {
                  "Retry-After": {
                    schema: { type: "integer", minimum: 1 },
                    description: "Seconds before retry",
                  },
                },
              }
            : {}),
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      ]),
  );
  const documentedErrors =
    !cardRead && sharedErrorGroups.has(route.path.split("/")[1])
      ? Object.fromEntries(
          Object.entries(errors).map(([status, response]) => {
            // These descriptions depend on the operation, unlike standard errors.
            if (status === "409" && tokenMutation) {
              responses.IntegrationRequestConflict = {
                ...response,
                description:
                  "Identity reused for different input/operation, uncertain pending outcome, expired identity or unavailable result. The effect is never dispatched again on replay.",
              };
              return [
                status,
                { $ref: "#/components/responses/IntegrationRequestConflict" },
              ];
            }
            if (status === "404" || status === "409") return [status, response];
            const key = "WorkspaceError" + status;
            responses[key] = response;
            return [status, { $ref: "#/components/responses/" + key }];
          }),
        )
      : errors;
  const operation = {
    operationId: name,
    ...(transport
      ? {
          description:
            route.protocol === "mcp"
              ? "Opaque MCP JSON-RPC transport. The MCP handler owns all methods, authentication and responses, including streaming. Its 12 MB JSON parser runs before dispatch. The workspace registrar does not validate or project protocol messages. Browser Origin headers are refused."
              : "Better Auth owns request validation, session cookies, redirects and response bodies. This protocol endpoint bypasses workspace input/output projection; single-user installations retain their existing personal-workspace response or refusal.",
          "x-loop-transport": route.protocol,
          ...(route.method === "ALL" ? { "x-loop-method": "ALL" } : {}),
        }
      : {}),
    parameters,
    security: transport
      ? route.protocol === "mcp"
        ? [{ FederationBearer: [] }]
        : [{ OwnerSession: [] }, {}]
      : route.security === "public"
        ? []
        : route.security === "integration-token"
          ? [{ IntegrationBearer: [] }]
          : route.security === "paired-device"
            ? [{ PairedDevice: [], ...(writes ? { PairedCsrf: [] } : {}) }]
            : route.security === "local-setup"
              ? [{ LocalSourceSetup: [] }]
              : [
                  ...(route.security === "optional-session" ? [{}] : []),
                  ...(admission ? [{ IntegrationBearer: [] }] : []),
                  { OwnerSession: [] },
                  { PairedDevice: [], ...(writes ? { PairedCsrf: [] } : {}) },
                ],
    ...(admission ? { "x-scopes": admission } : {}),
    ...(tokenMutation
      ? {
          "x-request-identity": route.identity,
          description:
            "Bearer identity required; replay: IntegrationBearer." +
            (name === "submit"
              ? " The send key also remains unique per owner across tokens and browser sessions."
              : "") +
            (name === "runAction"
              ? " Bearers may only cancel or dismiss; pause, resume and retry require a session."
              : ""),
        }
      : {}),
    ...(cardRead
      ? {
          "x-card-grants": admission.filter(
            (value) => value === "results:read" || value === "cards:read",
          ),
        }
      : {}),
    ...(!noBody(route.body)
      ? {
          requestBody: {
            required:
              !!route.multipart || !route.body.safeParse(undefined).success,
            content: {
              [route.multipart ? "multipart/form-data" : "application/json"]: {
                schema: { $ref: "#/components/schemas/" + prefix + "Body" },
              },
            },
          },
        }
      : {}),
    responses: {
      ...Object.fromEntries(
        [route.status ?? 200, ...(route.additionalStatuses ?? [])].map(
          (status) => [
            status,
            status >= 400
              ? { ...response, description: "Declared error response" }
              : response,
          ],
        ),
      ),
      ...(transport
        ? {
            default: {
              description:
                "Protocol-owned response, including errors, redirects and streaming. The workspace registrar does not reshape it.",
            },
          }
        : documentedErrors),
    },
  };
  if (name === "tokenEvents") {
    operation.responses[101] = {
      description:
        "WebSocket upgrade; canonical frames and acknowledgements are defined by openapi-channels.json.",
    };
    operation.responses[426].description =
      "WebSocket upgrade required; GET/HEAD without an upgrade never opens or replaces a token socket.";
    operation.responses[426].headers = {
      Upgrade: { schema: { type: "string", const: "websocket" } },
    };
  }
  paths[path] ||= {};
  paths[path][method] = operation;
  // Preserve the previously published Cards HEAD operations. Other contracts
  // contribute their declared operation; Express still owns HEAD fallback.
  if (method === "get" && cardNames[name])
    paths[path].head = {
      ...operation,
      operationId: name + "Head",
      responses: Object.fromEntries(
        Object.entries(operation.responses).map(([status, response]) => [
          status,
          { ...response, content: undefined },
        ]),
      ),
    };
}
const document = {
  openapi: "3.1.0",
  info: {
    title: "Loop API",
    version: "1",
    description:
      "Workspace HTTP contracts, integration-token admission and complete stored Cards content. See cards-api.md for scopes, deployment authentication and synchronization.",
  },
  paths,
  components: {
    schemas,
    responses,
    parameters: {
      IntegrationWriteOrigin: {
        name: "Origin",
        in: "header",
        required: false,
        schema: { type: "string", format: "uri" },
        description:
          "Required for OwnerSession and PairedDevice writes, with the existing paired CSRF credential. IntegrationBearer needs neither; a supplied disallowed Origin or cross-site Fetch Metadata is still refused.",
        "x-required-for": ["OwnerSession", "PairedDevice"],
      },
    },
    securitySchemes: {
      LocalSourceSetup: {
        type: "apiKey",
        in: "header",
        name: "x-loop-source-setup",
        description:
          "Must equal 1 on an authenticated single-user request arriving at the local authority. This is a source-adapter capability unavailable through paired-browser proxies; remote or multi-user requests are refused.",
      },
      FederationBearer: {
        type: "http",
        scheme: "bearer",
        description:
          "Service credential issued by local execution-source enrollment. The protocol handler authenticates it independently and refuses browser origins.",
      },
      IntegrationBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "loop_token_… (legacy loop_card_… accepted)",
        description:
          "Owner/source-bound integration credential. Only contracts whose x-scopes intersect its grants admit it. Never send tokens in URLs. Every admitted write requires its x-request-identity body field. Identity is scoped to owner and token; changed validated input or operation conflicts. Completed requests replay the first status with the current result projection, without invoking the effect again. Pending outcomes are uncertain and replay as 409. Result data expires after 24 hours; permanent credential-lifetime markers refuse old keys with 409.",
        "x-scope-catalog": SCOPE_CATALOG,
      },
      CardBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "loop_card_…",
        description:
          "Compatibility alias for IntegrationBearer for one release. Legacy results:read and cards:read retain their existing Cards-only permissions.",
      },
      OwnerSession: {
        type: "apiKey",
        in: "header",
        name: "Cookie",
        description:
          "Complete Cookie header from the authenticated Loop owner session, including cookie names. Preserve the deployment's names and values (HTTPS uses the __Secure- prefix). Browsers attach their cookie jar automatically; non-browser clients supply the complete header value.",
      },
      PairedDevice: {
        type: "apiKey",
        in: "header",
        name: "Cookie",
        description:
          "Complete Cookie header from the paired device session, including cookie names. Preserve the deployment's names and values (__Host-loop on HTTPS, loop_local on local HTTP, with an installation suffix for isolated previews). Browsers attach their cookie jar automatically; non-browser clients supply the complete header value. Management writes also require PairedCsrf.",
      },
      PairedCsrf: {
        type: "apiKey",
        in: "header",
        name: "x-loop-csrf",
        description:
          "Required together with PairedDevice for management writes. Read the csrf value from the authenticated /session response. Also send the matching workspace Origin header.",
      },
    },
  },
};
// One line per operation/component keeps generated additions within review
// capture limits as the registry grows, while preserving an inspectable outline.
function formatDocument(value, depth = 0) {
  if (depth >= 3 || !value || typeof value !== "object" || Array.isArray(value))
    return JSON.stringify(value);
  const entries = Object.entries(value).filter(
    ([, child]) => child !== undefined,
  );
  if (!entries.length) return "{}";
  return (
    "{\n" +
    entries
      .map(
        ([key, child]) =>
          " ".repeat(depth + 1) +
          JSON.stringify(key) +
          ": " +
          formatDocument(child, depth + 1),
      )
      .join(",\n") +
    "\n" +
    " ".repeat(depth) +
    "}"
  );
}
const output = formatDocument(document) + "\n";
const target = new URL("../docs/openapi.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== output)
    throw new Error("OpenAPI is stale. Run npm run openapi");
  console.log("OpenAPI matches runtime schemas and routes");
} else await writeFile(target, output);

await import("./fleet-openapi.mjs");
await import("./fleet-admin-openapi.mjs");

await import("./openapi-channels.mjs");
