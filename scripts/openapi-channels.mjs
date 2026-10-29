import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { workspaceApi, workspaceRoutes } from "../src/shared/workspace-api.ts";
import {
  WorkspaceEventDecoder,
  WorkspaceScope,
  WorkspaceSubject,
} from "../src/shared/workspace-events.ts";

const channel = workspaceApi.channels.events;
const tokenChannel = workspaceApi.channels.tokenEvents;
const registry = z.registry();
for (const [id, schema] of Object.entries({
  WorkspaceFrameV3: channel.frames,
  WorkspaceEvent: channel.event,
  WorkspaceCapabilities: channel.capabilities,
  WorkspaceClock: channel.clock,
  TokenEventAck: tokenChannel.confirmation,
  WorkspaceScope,
  WorkspaceSubject,
}))
  registry.add(schema, { id });

const { schemas } = z.toJSONSchema(registry, {
  target: "draft-2020-12",
  io: "output",
  uri: (id) => "#/components/schemas/" + id,
  // The tolerant decoder maps unknown historical/future events to invalidate.
  // Its canonical output is the registered event union, never a second copy.
  unrepresentable: ({ zodSchema }) =>
    zodSchema === WorkspaceEventDecoder.out
      ? { $ref: "#/components/schemas/WorkspaceEvent" }
      : "throw",
});
schemas.WorkspaceEventsQuery = z.toJSONSchema(channel.query, {
  target: "draft-2020-12",
  io: "input",
});
schemas.TokenEventsQuery = z.toJSONSchema(tokenChannel.query, {
  target: "draft-2020-12",
  io: "input",
});
for (const schema of Object.values(schemas)) {
  delete schema.$schema;
  delete schema.$id;
}
const fallback = Object.entries(workspaceRoutes).find(
  ([, route]) => route === channel.fallback,
);
if (!fallback)
  throw new Error("Socket fallback must be a registered HTTP route");
const [fallbackId, fallbackRoute] = fallback;
const document = {
  openapi: "3.1.0",
  info: {
    title: "Loop workspace event channels",
    version: "3",
    description:
      "Companion to openapi.json. Event variants describe canonical decoded output; unknown or malformed events decode to invalidate. Serialized byte/depth bounds remain runtime constraints. Browser sockets accept no client writes; token sockets accept only delivery acknowledgements.",
  },
  paths: {},
  "x-channels": {
    events: {
      kind: channel.kind,
      path: "/api" + channel.path,
      pairedPath: channel.pairedPath,
      description:
        "Owner session on the server; paired device session on the host. Cards tokens are not accepted. v=3 negotiates these frames; other or absent versions retain legacy v2. epoch and cursor resume replay; clock=1 and projection=1 negotiate clock and capability additions. The first value of each query key is used.",
      query: { $ref: "#/components/schemas/WorkspaceEventsQuery" },
      frames: { $ref: "#/components/schemas/WorkspaceFrameV3" },
      clock: { $ref: "#/components/schemas/WorkspaceClock" },
      httpFallback: {
        operationId: fallbackId,
        method: fallbackRoute.method,
        path: "/api" + fallbackRoute.path,
        query: {
          $ref: "./openapi.json#/components/schemas/" + fallbackId + "Query",
        },
        response: {
          $ref: "./openapi.json#/components/schemas/" + fallbackId + "Response",
        },
      },
    },
    tokenEvents: {
      kind: tokenChannel.kind,
      path: "/api" + tokenChannel.path,
      security: [tokenChannel.security],
      description:
        "Read integration bearer in the WebSocket upgrade header only. Server text messages contain the same v3 frames and projected message/decision content as the browser channel. Confirm an offered epoch/cursor with a TokenEventAck JSON text message on this same socket after processing or reset reconciliation. Only confirmed progress is durable; a replacement fences earlier confirmations. Bare reconnect resumes the confirmed checkpoint; after requests earlier replay. Invalid acknowledgements close the connection without advancing it. Authority is checked before every frame, on acknowledgements and every 25 seconds while idle. Plain GET/HEAD returns 426 without opening or replacing a socket. Handshakes and acknowledgements share token request limits; inbound messages are limited to 1024 bytes.",
      query: { $ref: "#/components/schemas/TokenEventsQuery" },
      frames: { $ref: "#/components/schemas/WorkspaceFrameV3" },
      confirmation: {
        $ref: "#/components/schemas/TokenEventAck",
      },
      httpFallback: {
        operationId: fallbackId,
        method: fallbackRoute.method,
        path: "/api" + fallbackRoute.path,
        response: { $ref: "./openapi.json#/components/schemas/eventsResponse" },
      },
    },
  },
  components: {
    schemas,
    securitySchemes: {
      IntegrationBearer: {
        type: "http",
        scheme: "bearer",
        description: "Integration token with read scope",
      },
    },
  },
};
// Keep the channel document independent so Cards retains local-only references.
const output = JSON.stringify(document, null, 2) + "\n";
const target = new URL("../docs/openapi-channels.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== output)
    throw new Error("Event channels are stale. Run npm run openapi");
  console.log("Event channels match runtime schemas and registry");
} else await writeFile(target, output);
