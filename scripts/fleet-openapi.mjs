import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { fleetPeerApi } from "../src/shared/fleet-peer-api.ts";
import { fleetHandoffApi } from "../src/shared/fleet-handoff-api.ts";
import { fleetDirectoryApi } from "../src/shared/fleet-directory-api.ts";
import { fleetCredentialApi } from "../src/shared/fleet-credential-api.ts";
import { fleetPendingDirectoryApi } from "../src/shared/fleet-pending-directory-api.ts";

// A separate document describes this machine protocol: its body proofs and
// rejected browser credentials are different from workspace session security.
const options = { target: "draft-2020-12" };
const schemas = {
  FleetError: z.toJSONSchema(z.object({ error: z.string() }).strict(), options),
};
const paths = {};
const proof = {
  credentialChallenge:
    "Returns a signed, short-lived challenge only for a currently authorized destination grant, peer, directory and operation. A challenge grants no access and allocates no per-request nonce state.",
  credentialIssue:
    "Requires the enrolled peer's signature over this issuer instance's unexpired challenge and the client's request nonce. Consumes the challenge durably before returning a ten-minute operation-scoped credential. A lost response requires a new challenge; it never authorizes replay of an agent effect.",
  pendingDirectoryHead:
    "Requires a nonce-bound machine proof for a member of this pending consent's verified checkpoint. Reports only that destination-issued grant and checkpoint, without activating workspace access. Completed grants also require current local membership.",
  pendingDirectoryPush:
    "Relays a complete signed successor chain from this exact inactive enrollment operation's trusted checkpoint. Every edge must be authorized by the locally approved controller or its signed handoff. A relay need not occur in the earlier roster; it cannot install membership or grants. A verified removal cancels only the named operation durably, even if another ceremony reuses its grant. Exact packet receipts survive restart; completed enrollment is reported separately for ordinary synchronization.",
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
    "Requires a nonce-bound machine signature. Current members may retrieve signed history from an enrolled replica without an access credential or controller connection. A new member may prove its admission with at most 1,024 signed entries and 768 KiB, connected to the receiver's current head; this read changes no grant. Removed members may retrieve only the chain ending at their recorded removal after proving their former key; later revisions and unrelated cursors are refused. Unanchored pages do not create trust.",
  directoryPush:
    "Requires an enrolled sender's nonce-bound signature and a complete signed successor chain from a known local anchor. Updates only existing locally approved grants. Unknown enrollments, forks and automatic recovery resets are refused; a signed acknowledgement reports the exact accepted chain.",
};
for (const [name, route] of Object.entries({
  ...fleetPeerApi,
  ...fleetHandoffApi,
  ...fleetDirectoryApi,
  ...fleetCredentialApi,
  ...fleetPendingDirectoryApi,
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
        name === "enrollmentProbe" || name === "credentialChallenge"
          ? "public challenge; credential challenges require an active grant context"
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
