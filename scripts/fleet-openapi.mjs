import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { fleetWorkspaceApi } from "../src/shared/fleet-workspace-api.ts";
import { fleetWorkspaceActionApi } from "../src/shared/fleet-workspace-action-api.ts";
import { fleetWorkspaceFileApi } from "../src/shared/fleet-workspace-file-api.ts";
import { fleetWorkspaceUploadApi } from "../src/shared/fleet-workspace-upload-api.ts";
import { fleetPeerApi } from "../src/shared/fleet-peer-api.ts";
import { fleetHandoffApi } from "../src/shared/fleet-handoff-api.ts";
import { fleetDirectoryApi } from "../src/shared/fleet-directory-api.ts";
import { fleetCredentialApi } from "../src/shared/fleet-credential-api.ts";
import { fleetPendingDirectoryApi } from "../src/shared/fleet-pending-directory-api.ts";
import { fleetMailApi } from "../src/shared/fleet-mail-api.ts";

// A separate document describes this machine protocol: its body proofs and
// rejected browser credentials are different from workspace session security.
const options = { target: "draft-2020-12" };
const schemas = {
  FleetError: z.toJSONSchema(z.object({ error: z.string() }).strict(), options),
};
function component(schema, name, io) {
  const result = z.toJSONSchema(schema, { ...options, io });
  const root =
    "#/components/schemas/" + name.replace(/~/g, "~0").replace(/\//g, "~1");
  function references(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#"))
      value.$ref = root + value.$ref.slice(1);
    for (const child of Object.values(value)) references(child);
  }
  references(result);
  return result;
}
const paths = {};
// Fleet uses only its dedicated peer/device credentials.
// Action submission and receipt lookup return the same signed envelope.
const responseNames = new Map([
  [fleetWorkspaceActionApi.action.response, "workspaceActionResponse"],
]);

const proof = {
  mailDirectory:
    "Requires a mail-scoped machine credential. Returns only bounded local agent names, IDs and runtime availability. No prompts, connection records, recursive remote discovery or browser session are accepted. Responses bind the current directory, requesting machine and canonical query digest.",
  mailPrepare:
    "Reserves the original source/message/digest under both current mail grants without queueing work or granting file/context access. Its durable signed prepared receipt is the only permission to transmit that same envelope after reconciling an ambiguous send. Reservations expire after thirty minutes into retained refusal tombstones. Missing receipts never authorize a new reservation for an uncertain send.",
  mailAccept:
    "Requires a mail-scoped machine credential, its durable reservation and a one-hop envelope attributed to that authenticated sending machine. Current source and destination grants must match its immutable pins. Admission and the existing mail queue share one transaction; a duplicate source/message identity returns its original receipt without dispatch. Accepted does not mean read. This route is only installed when the owning mail service is configured.",
  mailReceipt:
    "Requires a mail-scoped machine credential and the original source/message identity and payload digest. Reads the destination's admitted mail state without dispatch. A missing row remains unknown and never authorizes a replacement message. Signed responses include the request identity, method and monotonic receipt revision.",
  mailFile:
    "Requires the authenticated mail peer, a current file-sharing grant, the original envelope digest and its unaccepted destination reservation. Stages at most 192 KiB per chunk and reserves at most 256 MiB across the receiving machine. No agent URL or path is accepted. The signed next offset permits resuming identical private chunks. Verified complete bytes become local attachments only inside the recipient mail-admission transaction; staging alone grants no artifact or model-context access.",
  workspaceUploadPrepare:
    "Requires a files-scoped machine credential and a canonical upload manifest bound to its original command. Stages at most two files of up to 25 MiB for 30 idle or 120 total seconds. Staging is ephemeral, creates no workspace file or agent grant, and is not command acceptance. An existing durable command returns its receipt instead of a new staging area.",
  workspaceUploadChunk:
    "Requires the original files-scoped peer, grant, directory, command, payload digest and transfer. Appends at most 256 KiB at the exact expected offset. Signs the request digest and resulting offset. No workspace object is created.",
  workspaceUploadClose:
    "Requires the original files-scoped peer, command and payload digest. Deletes only its ephemeral staging area; a missing area is already closed. Never removes or changes a durable command receipt.",
  workspaceUploadCommit:
    "Requires complete staged bytes matching the original manifest's size and SHA-256. Persists the original command and digest before invoking the owning upload producer, which rechecks the current grant inside its file transaction. Repeated commits only return the durable receipt, including after restart. A lost reply does not authorize a new upload.",
  workspaceUploadReceipt:
    "Requires a files-scoped machine credential and the original command ID and payload digest. Returns a signed durable upload receipt without creating or committing a file. A missing receipt remains unknown to the gateway.",
  workspaceFileOpen:
    "Requires a files-scoped machine credential. Opens only a named owning workspace file projection, up to 25 MiB, with a signed byte count and SHA-256 checksum. At most two snapshots remain live for 30 idle seconds or 120 total seconds. The owner, grant and signed directory are rechecked before admission and after the owning handler.",
  workspaceFileChunk:
    "Requires a files-scoped machine credential for the original peer, grant and directory. Returns at most 256 KiB of base64-encoded bytes signed together with the fresh request identity, transfer, checksum and offsets. Permission changes, deleted objects and expired transfers are refused.",
  workspaceFileClose:
    "Requires a files-scoped machine credential. Releases the original peer's bounded snapshot; a missing transfer is already closed. Does not publish files or grant agent-mail access.",
  workspaceCatalog:
    "Requires a destination-owner machine credential. Signs request identity and configured capabilities intersected with its grant; absent capabilities confer no access.",
  workspaceRead:
    "Requires a read credential and allowlisted local projection, including read-only routing/sharing previews. Runs destination middleware, projects bounded results and rechecks grant/directory before signing the input digest and result. No caller-selected URL, source, owner, headers, private admin/native/provider setup or recursive routing.",
  workspaceAction:
    "Requires an act credential and allowlisted local action. Records the command and parsed wire digest before its owning handler; defaults cannot change that digest. Rechecks grants and native generations at owning boundaries. Never replays uncertain work.",
  workspaceReceipt:
    "Requires an act credential, original command ID and parsed wire digest. The required action name binds typed recovery and atomically retires an absent ID without dispatch. Missing or unverifiable receipts preserve uncertainty.",
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
  mailDirectory: fleetMailApi.directory,
  mailPrepare: fleetMailApi.prepare,
  mailAccept: fleetMailApi.accept,
  mailReceipt: fleetMailApi.receipt,
  mailFile: fleetMailApi.file,
  workspaceCatalog: fleetWorkspaceApi.catalog,
  workspaceRead: fleetWorkspaceApi.read,
  workspaceAction: fleetWorkspaceActionApi.action,
  workspaceReceipt: fleetWorkspaceActionApi.receipt,
  workspaceFileOpen: fleetWorkspaceFileApi.open,
  workspaceFileChunk: fleetWorkspaceFileApi.chunk,
  workspaceFileClose: fleetWorkspaceFileApi.close,
  workspaceUploadPrepare: fleetWorkspaceUploadApi.prepare,
  workspaceUploadChunk: fleetWorkspaceUploadApi.chunk,
  workspaceUploadClose: fleetWorkspaceUploadApi.close,
  workspaceUploadCommit: fleetWorkspaceUploadApi.commit,
  workspaceUploadReceipt: fleetWorkspaceUploadApi.receipt,
})) {
  if (typeof route.access !== "string")
    throw new Error("Fleet routes cannot admit integration tokens");
  schemas[name + "Request"] = component(route.body, name + "Request", "input");
  const responseName = responseNames.get(route.response) || name + "Response";
  schemas[responseName] ??= component(route.response, responseName, "output");
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
          : name === "workspaceCatalog"
            ? "opaque machine credential in the strict JSON body; destination maps the owner and intersects capabilities with its current grant"
            : name.startsWith("workspaceFile") ||
                name.startsWith("workspaceUpload")
              ? "files-scoped opaque machine credential in the strict JSON body; destination maps the local owner"
              : name === "workspaceAction" || name === "workspaceReceipt"
                ? "act-scoped opaque machine credential in the strict JSON body; destination maps the local owner"
                : name === "workspaceRead"
                  ? "read-scoped opaque machine credential in the strict JSON body; destination maps the local owner"
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
          description:
            name === "workspaceCatalog" || name === "workspaceRead"
              ? "Signed bounded local projection with correlated request, input digest and machine/grant identities; never a device cookie."
              : "Signed fleet protocol response; never a device cookie.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/" + responseName },
            },
          },
        },
        ...Object.fromEntries(
          [
            400,
            403,
            404,
            405,
            409,
            413,
            415,
            ...(name === "workspaceFileChunk" ? [416] : []),
            500,
            502,
            503,
            504,
          ].map((status) => [status, error]),
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
