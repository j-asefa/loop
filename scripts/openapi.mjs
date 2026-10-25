import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { workspaceApi, CardErrorSchema } from "../src/shared/workspace-api.ts";
import {
  ResultCardSchema,
  MessageCardSchema,
  CardSchema,
  CardEntrySchema,
} from "../src/shared/cards.ts";
import { CardTokenSchema } from "../src/shared/card-access.ts";
// Request schemas describe accepted input (including transforms); responses
// describe projected output. Both are populated only from workspaceApi.
const registry = z.registry(), inputs = z.registry();
// These published component names survive the registry merge. Operation IDs
// follow workspaceApi's stable keys; this map is only a schema-name alias.
const cardNames = {
  cardList: "list", cardChanges: "changes", cardDetail: "detail",
  cardTokens: "tokens", cardTokenCreate: "createToken", cardTokenRevoke: "revokeToken",
};
const schemaName = name => cardNames[name] ?? name;
const noBody = body => body instanceof z.ZodUndefined;
const jsonOptions = {
  target: "draft-2020-12",
  // No JSON value satisfies NoBody. Keep its registered schema explicit while
  // omitting requestBody from the operation; other unsupported schemas fail.
  unrepresentable: ({ zodSchema }) => zodSchema instanceof z.ZodUndefined ? { not: {} } : "throw",
};
for (const [id, schema] of Object.entries({
  ResultCard: ResultCardSchema,
  MessageCard: MessageCardSchema,
  Card: CardSchema,
  CardEntry: CardEntrySchema,
  CardToken: CardTokenSchema,
  Error: CardErrorSchema,
}))
  registry.add(schema, { id });
for (const [name, route] of Object.entries(workspaceApi)) {
  const prefix = schemaName(name);
  // Clones give shared Empty/NoBody and repeated responses distinct IDs.
  // Cards response identities retain their existing inter-component references.
  registry.add(route.kind === "stream" ? z.string().meta({ format: "binary" }) : cardNames[name] ? route.response : route.response.clone(), { id: prefix + "Response" });
  inputs.add(route.params.clone(), { id: prefix + "Params" });
  inputs.add(route.query.clone(), { id: prefix + "Query" });
  inputs.add(route.body.clone(), { id: prefix + "Body" });
}
function registeredSchemas(registry, io, sharedId) {
  const { schemas } = z.toJSONSchema(registry, {
    ...jsonOptions, io,
    uri: id => "#/components/schemas/" + (id === "__shared" ? sharedId : id),
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
      value.$ref = value.$ref.replace(/^(#\/components\/schemas\/[^#]+)#\//, "$1/");
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
const paths = {};
for (const [name, route] of Object.entries(workspaceApi)) {
  const path = "/api" + route.path.replace(/:([^/]+)/g, "{$1}");
  const method = route.method.toLowerCase();
  const writes = method !== "get";
  const cardRead = route.access.startsWith("card:");
  const prefix = schemaName(name);
  const parameters = [];
  if (writes)
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
  const params = z.toJSONSchema(route.params, jsonOptions);
  for (const [key, schema] of Object.entries(params.properties || {}))
    parameters.push({ name: key, in: "path", required: true, schema });
  const response = {
    description: "Successful response",
    content: {
      [route.kind === "stream" ? route.contentType ?? "application/octet-stream" : "application/json"]: {
        schema: { $ref: "#/components/schemas/" + prefix + "Response" },
      },
    },
  };
  const errorStatuses = [400, 401, 403, 429, 500];
  if (cardRead) errorStatuses.push(404);
  if (name === "cardChanges" || name === "cardTokenCreate") errorStatuses.push(409);
  if (name === "cardTokenRevoke") errorStatuses.push(404);
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
                : "Card or selected object not available",
            409:
              name === "cardTokenCreate"
                ? "Creation conflict, revoked identity or secret, or active-token limit"
                : "Cursor no longer valid; reset selection",
            429: "Request limit reached",
            500: "Server error",
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
  const operation = {
    operationId: name,
    parameters,
    security: [
      ...(cardRead ? [{ CardBearer: [] }] : []),
      { OwnerSession: [] },
      { PairedDevice: [], ...(writes ? { PairedCsrf: [] } : {}) },
    ],
    ...(cardRead
      ? { "x-card-grants": route.access === "card:results" ? ["results:read", "cards:read"] : ["cards:read"] }
      : {}),
    ...(!noBody(route.body)
      ? {
          requestBody: {
            required: !route.body.safeParse(undefined).success,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/" + prefix + "Body" },
              },
            },
          },
        }
      : {}),
    responses: { ...Object.fromEntries([route.status ?? 200, ...(route.additionalStatuses ?? [])].map(status => [status, response])), ...errors },
  };
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
      "Workspace HTTP contracts and complete stored Cards content. Collection cursors bind owner, database and normalized selection. This general document describes authenticated requests. Trusted single-user standalone installations may additionally accept requests inside their configured access boundary; that deployment exception is not a global anonymous security alternative. See cards-api.md for synchronization, scope and deployment semantics.",
  },
  paths,
  components: {
    schemas,
    securitySchemes: {
      CardBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "loop_card_…",
        description:
          "Read routes only. results:read permits Results; cards:read permits Results, Saved and Sent. Never send tokens in URLs.",
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
  const entries = Object.entries(value).filter(([, child]) => child !== undefined);
  if (!entries.length) return "{}";
  return "{\n" + entries.map(([key, child]) =>
    " ".repeat(depth + 1) + JSON.stringify(key) + ": " + formatDocument(child, depth + 1),
  ).join(",\n") + "\n" + " ".repeat(depth) + "}";
}
const output = formatDocument(document) + "\n";
const target = new URL("../docs/openapi.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== output)
    throw new Error("OpenAPI is stale. Run npm run openapi");
  console.log("OpenAPI matches runtime schemas and routes");
} else await writeFile(target, output);
