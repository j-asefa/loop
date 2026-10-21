import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { cardApi, CardErrorSchema } from "../src/shared/card-api.ts";
import {
  ResultCardSchema,
  MessageCardSchema,
  CardSchema,
  CardEntrySchema,
} from "../src/shared/cards.ts";
import { CardTokenSchema } from "../src/shared/card-access.ts";
const registry = z.registry();
for (const [id, schema] of Object.entries({
  ResultCard: ResultCardSchema,
  MessageCard: MessageCardSchema,
  Card: CardSchema,
  CardEntry: CardEntrySchema,
  CardToken: CardTokenSchema,
  Error: CardErrorSchema,
}))
  registry.add(schema, { id });
for (const [name, route] of Object.entries(cardApi)) {
  registry.add(route.response, { id: name + "Response" });
  if (route.body) registry.add(route.body, { id: name + "Body" });
}
const { schemas } = z.toJSONSchema(registry, {
  target: "draft-2020-12",
  uri: (id) => "#/components/schemas/" + id,
});
for (const schema of Object.values(schemas)) {
  delete schema.$schema;
  delete schema.$id;
}
const paths = {};
for (const [name, route] of Object.entries(cardApi)) {
  const path = "/api" + route.path.replace(/:([^/]+)/g, "{$1}");
  const writes = route.method !== "get";
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
    const query = z.toJSONSchema(route.query, { target: "draft-2020-12" });
    const input = z.toJSONSchema(route.query, {
      target: "draft-2020-12",
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
  if (route.id) {
    const schema = z.toJSONSchema(route.id);
    delete schema.$schema;
    parameters.push({ name: "id", in: "path", required: true, schema });
  }
  const response = {
    description: "Successful response",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/" + name + "Response" },
      },
    },
  };
  const errorStatuses = [400, 401, 403, 429, 500];
  if (route.access === "read") errorStatuses.push(404);
  if (name === "changes" || name === "createToken") errorStatuses.push(409);
  if (name === "revokeToken") errorStatuses.push(404);
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
              name === "revokeToken"
                ? "Token not found for this owner"
                : "Card or selected object not available",
            409:
              name === "createToken"
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
      ...(route.access === "read" ? [{ CardBearer: [] }] : []),
      { OwnerSession: [] },
      { PairedDevice: [], ...(writes ? { PairedCsrf: [] } : {}) },
    ],
    ...(route.access === "read"
      ? { "x-card-grants": ["results:read", "cards:read"] }
      : {}),
    ...(route.body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/" + name + "Body" },
              },
            },
          },
        }
      : {}),
    responses: { [route.status]: response, ...errors },
  };
  paths[path] ||= {};
  paths[path][route.method] = operation;
  if (route.method === "get")
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
    title: "Loop Cards API",
    version: "1",
    description:
      "Complete stored content. Collection cursors bind owner, database and normalized selection. This general document describes authenticated requests. Trusted single-user standalone installations may additionally accept requests inside their configured access boundary; that deployment exception is not a global anonymous security alternative. See cards-api.md for synchronization, scope and deployment semantics.",
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
const output = JSON.stringify(document, null, 1) + "\n";
const target = new URL("../docs/cards-openapi.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== output)
    throw new Error("Cards OpenAPI is stale. Run npm run cards:openapi");
  console.log("Cards OpenAPI matches runtime schemas and routes");
} else await writeFile(target, output);
