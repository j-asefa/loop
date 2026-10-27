import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { fleetPeerApi } from "../src/shared/fleet-peer-api.ts";
import { fleetHandoffApi } from "../src/shared/fleet-handoff-api.ts";
import { fleetDirectoryApi } from "../src/shared/fleet-directory-api.ts";

// A separate document describes this machine protocol: its body proofs and
// rejected browser credentials are different from workspace session security.
const options = { target: "draft-2020-12" };
const schemas = {
  FleetError: z.toJSONSchema(z.object({ error: z.string() }).strict(), options),
};
const paths = {};
const proof = {
  enrollmentProbe:
    "Returns a signature over the supplied fresh nonce, confirmed origin and exact destination identity. No enrollment capability is needed.",
  enrollmentPrepare:
    "Requires the destination's one-time enrollment capability and a controller signature over the exact intent. Consumes both local ceremony capabilities atomically with a pending grant; does not create a device cookie.",
  enrollmentCommit:
    "Requires the original controller's signature and the bound canonical successor directory. Activates only the pending destination consent. Exact completed retries return the durable receipt.",
  enrollmentReceipt:
    "Requires the original controller's signature over the operation and intent digest. Returns a signed receipt without replaying enrollment.",
  handoffCommit:
    "Requires the old controller's directory signature over the exact next-epoch handoff. The enrolled destination durably accepts with its own signature and queues dissemination. Repeated accepted proposals return the same signed transition without restoring an obsolete authority.",
  handoffReceipt:
    "Requires the old controller's nonce-bound query signature and its locally known predecessor. A signed missing receipt is an observation, never permission to reactivate the old writer or replay the proposal.",
  directoryHistory:
    "Requires a nonce-bound machine signature. Current members may retrieve signed history from an enrolled replica without an access credential or controller connection. Removed members may retrieve only the chain ending at their recorded removal after proving their former key; later revisions and unrelated cursors are refused. Unanchored pages do not create trust.",
  directoryPush:
    "Requires an enrolled sender's nonce-bound signature and a complete signed successor chain from a known local anchor. Updates only existing locally approved grants. Unknown enrollments, forks and automatic recovery resets are refused; a signed acknowledgement reports the exact accepted chain.",
};
for (const [name, route] of Object.entries({
  ...fleetPeerApi,
  ...fleetHandoffApi,
  ...fleetDirectoryApi,
})) {
  schemas[name + "Request"] = z.toJSONSchema(route.body, {
    ...options,
    io: "input",
  });
  schemas[name + "Response"] = z.toJSONSchema(route.response, options);
  const error = {
    description:
      "A safe protocol error. A failed or missing response does not prove an effect was absent.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/FleetError" },
      },
    },
  };
  paths["/api" + route.path] = {
    post: {
      operationId: name,
      description:
        proof[name] +
        " Browser Origin, Cookie, Authorization, CSRF, method-override and Sec-Fetch headers are refused. Host must match the serving companion's current HTTPS origin. Query strings and alternate path spellings are rejected.",
      // OpenAPI has no HTTP security scheme for signed JSON bodies. The strict
      // request schema and this extension describe the required authentication;
      // browser/session bearer schemes would be incorrect alternatives.
      security: [],
      "x-loop-access": route.access,
      "x-loop-authentication":
        name === "enrollmentProbe"
          ? "public identity challenge"
          : "signed request body; prepare also requires a one-time capability",
      parameters: [
        {
          name: "X-Loop-Fleet-Version",
          in: "header",
          required: true,
          schema: { type: "string", const: "1" },
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
      responses: {
        200: {
          description: "Signed fleet protocol response; never a device cookie.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/" + name + "Response" },
            },
          },
        },
        ...Object.fromEntries(
          [400, 403, 404, 405, 409, 413, 415, 500, 503].map((status) => [
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
    title: "Loop companion fleet protocol",
    version: "1",
    description:
      "Dedicated machine-to-machine JSON protocol. Available on non-preview companions only. Each request/response is limited to 4 MiB; the transport does not follow redirects, accept private DNS destinations, forward cookies or automatically repeat uncertain effects. Read the protocol-specific proof requirements on each operation.",
  },
  paths,
  components: { schemas },
};
const output = JSON.stringify(document, null, 2) + "\n";
const path = new URL("../docs/fleet-openapi.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output)
    throw new Error("Fleet OpenAPI document is stale; run npm run openapi.");
} else await writeFile(path, output);
