import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { fleetGatewayApi } from "../src/shared/fleet-gateway-api.ts";

const options = { target: "draft-2020-12" };
const schemas = {
  FleetGatewayError: z.toJSONSchema(
    z.object({ error: z.string() }).strict(),
    options,
  ),
};
const paths = {};
for (const [name, route] of Object.entries(fleetGatewayApi)) {
  schemas[name + "Response"] = z.toJSONSchema(route.response, options);
  const mutation = route.method !== "GET";
  if (mutation)
    schemas[name + "Request"] = z.toJSONSchema(route.body, {
      ...options,
      io: "input",
    });
  const error = {
    description:
      "A safe error. A lost response does not prove an effect was absent; inspect the existing operation before creating another.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/FleetGatewayError" },
      },
    },
  };
  paths["/api" + route.path] = {
    [route.method.toLowerCase()]: {
      operationId: "fleetGateway" + name[0].toUpperCase() + name.slice(1),
      description:
        "Available only through the companion Host's local paired-device boundary. Peers, Cards tokens, server sessions and previews cannot authorize this route. " +
        (mutation
          ? "Requires matching Origin and X-Loop55-CSRF; the local owner is selected by the host."
          : "Reads explicit public fields for the local owner."),
      "x-loop55-access": route.access,
      security: [
        mutation ? { LocalDevice: [], LocalCSRF: [] } : { LocalDevice: [] },
      ],
      ...(mutation
        ? {
            parameters: [
              {
                name: "Origin",
                in: "header",
                required: true,
                schema: { type: "string", format: "uri" },
                description: "The serving companion's exact HTTPS origin.",
              },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/" + name + "Request" },
                },
              },
            },
          }
        : {}),
      responses: {
        200: {
          description:
            "Original command receipt projected by its owning action contract.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/" + name + "Response" },
            },
          },
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 409, 413, 500, 502, 503].map((status) => [
            status,
            error,
          ]),
        ),
      },
    },
  };
}
const document = {
  openapi: "3.1.0",
  info: {
    title: "Loop55 local fleet command receipts",
    version: "1",
    description:
      "Receipt lookup for a paired device on this gateway. The immutable destination, command ID, route and payload digest select an original receipt; no action body is retained or replayed. Bodies are bounded to 4 KiB, with 16 active requests and a 45-second deadline.",
  },
  paths,
  components: {
    schemas,
    securitySchemes: {
      LocalDevice: { type: "apiKey", in: "cookie", name: "__Host-loop55" },
      LocalCSRF: { type: "apiKey", in: "header", name: "X-Loop55-CSRF" },
    },
  },
};
const output = JSON.stringify(document, null, 2) + "\n";
const path = new URL("../docs/fleet-gateway-openapi.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output)
    throw new Error("Fleet gateway OpenAPI is stale; run npm run openapi.");
} else await writeFile(path, output);
