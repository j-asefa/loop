import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { fleetAdminApi } from "../src/shared/fleet-admin-api.ts";

const options = { target: "draft-2020-12" };
const schemas = {
  FleetAdminError: z.toJSONSchema(
    z.object({ error: z.string() }).strict(),
    options,
  ),
};
const paths = {};
// Fleet uses only its dedicated peer/device credentials.

for (const [name, route] of Object.entries(fleetAdminApi)) {
  if (typeof route.access !== "string")
    throw new Error("Fleet routes cannot admit integration tokens");
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
        schema: { $ref: "#/components/schemas/FleetAdminError" },
      },
    },
  };
  paths["/api" + route.path] = {
    [route.method.toLowerCase()]: {
      operationId: "fleetAdmin" + name[0].toUpperCase() + name.slice(1),
      description:
        "Available only through the companion Host's local paired-device boundary. Peers, Cards tokens, server sessions and previews cannot authorize this route. " +
        (mutation
          ? "Requires matching Origin and X-Loop-CSRF; the local owner is selected by the host."
          : "Reads explicit public fields for the local owner."),
      "x-loop-access": route.access,
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
          description: "Projected local fleet administration response.",
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
    title: "Loop local fleet administration",
    version: "1",
    description:
      "Local paired-device operations. Enrollment-only links are sensitive and returned only by the explicit mint operation. Directory administration stays on its controller; fresh recovery consent chooses a new local lineage. Bodies are bounded to 256 KiB, with 16 active requests and a 60-second deadline.",
  },
  paths,
  components: {
    schemas,
    securitySchemes: {
      LocalDevice: { type: "apiKey", in: "cookie", name: "__Host-loop" },
      LocalCSRF: { type: "apiKey", in: "header", name: "X-Loop-CSRF" },
    },
  },
};
const output = JSON.stringify(document, null, 2) + "\n";
const path = new URL("../docs/fleet-admin-openapi.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output)
    throw new Error(
      "Fleet administration OpenAPI is stale; run npm run openapi.",
    );
} else await writeFile(path, output);
