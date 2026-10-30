import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { Headers, Response, type fetch as undiciFetch } from "undici";
import { Host } from "../src/host.js";
import { AgentSources } from "../src/agent-sources.js";
import { fleetAgentSource } from "../src/server/fleet-agent-source.js";
import { createFleetCommandsHttp } from "../src/server/fleet-commands-http.js";
import { fleetActionInput } from "../src/shared/fleet-action-input.js";
import { FleetPeerActions } from "../src/server/fleet-peer-actions.js";
import { FleetPeerReads } from "../src/server/fleet-peer-reads.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetWorkspaceRead } from "../src/server/fleet-workspace-read.js";
import { FleetWorkspaceActions } from "../src/server/fleet-workspace-actions.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { FleetWorkspaceFiles } from "../src/server/fleet-workspace-files.js";
import { FleetPeerFiles } from "../src/server/fleet-peer-files.js";
import { FleetWorkspaceUploads } from "../src/server/fleet-workspace-uploads.js";
import { FleetPeerUploads } from "../src/server/fleet-peer-uploads.js";
import {
  FleetUploadInput,
  fleetWorkspaceUploadApi,
} from "../src/shared/fleet-workspace-upload-api.js";
import { FleetProof } from "../src/server/fleet-proof.js";
import {
  fleetWorkspaceFileApi,
  FLEET_FILE_CHUNK_BYTES,
} from "../src/shared/fleet-workspace-file-api.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { applyMigrations } from "../src/server/migrations.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import {
  fleetActionRoutes,
  fleetWorkspaceActionApi,
} from "../src/shared/fleet-workspace-action-api.js";
import { fleetPeerApi } from "../src/shared/fleet-peer-api.js";
import { fleetDeviceFromLink } from "../src/shared/fleet-pairing.js";
import { until } from "./helpers.js";
import { DoneCardsReader } from "../src/client/feed-cards.js";
import { contractCardReader } from "../src/shared/card-client.js";
import { routePath } from "../src/shared/route-path.js";
import { contractDoneThreadReader } from "../src/shared/done-thread-client.js";
import { DONE_THREAD_PAGE_BYTES } from "../src/shared/done-threads.js";

const root = mkdtempSync(join(tmpdir(), "loop55-fleet-source-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = join(root, "destination");
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
mkdirSync(process.env.LOOP55_DATA_DIR);
mkdirSync(join(root, "gateway"));
const { FleetCredentialHttpTransport } =
  await import("../src/server/fleet-credential-http.js");
const { FleetWorkspaceHttpTransport } =
  await import("../src/server/fleet-workspace-http.js");
const { FleetWorkspaceActionHttpTransport } =
  await import("../src/server/fleet-workspace-action-http.js");
const { FleetWorkspaceFileHttpTransport } =
  await import("../src/server/fleet-workspace-file-http.js");
const { FleetWorkspaceUploadHttpTransport } =
  await import("../src/server/fleet-workspace-upload-http.js");
const { app } = await import("../src/server/index.js");
const { db } = await import("../src/server/db.js");
const { OWNER, nativeSessions } =
  await import("../src/server/native-sessions.js");
const { closeExecution } = await import("../src/server/execution-client.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
const { uploadFile } = await import("../src/server/uploads.js");
const { saveArtifact } = await import("../src/server/artifacts.js");
const secrets = await import("../src/server/secrets.js");
const sourceDb = new Database(join(root, "source.db"));
applyMigrations(sourceDb);
sourceDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
const source = new FleetAuthority(sourceDb, secrets),
  destination = new FleetAuthority(db, secrets),
  credentials = new FleetCredentials(db, destination, secrets),
  sourceCredentials = new FleetCredentials(sourceDb, source, secrets),
  owner = randomUUID(),
  foreignOwner = randomUUID(),
  origin = "https://destination.example";
let gatewayOrigin = "https://gateway.example";
const first = source.create(owner, {
  mutationId: randomUUID(),
  name: "Gateway",
  origin: gatewayOrigin,
  scope: ["read", "act", "files"],
});
const directory = source.revise(owner, {
  mutationId: randomUUID(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    { ...destination.identity, origin, name: "Remote", grantId: randomUUID() },
  ],
});
destination.approve(OWNER, {
  mutationId: randomUUID(),
  expected: null,
  kind: "enroll",
  scope: ["read", "act", "files"],
  controller: source.identity,
  directory,
  grantId: directory.document.members[1].grantId,
});
const bridge = new FleetWorkspaceApp(app, OWNER);
const actions = new FleetWorkspaceActions(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
);
const reads = new FleetWorkspaceRead(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
  { actions: () => Object.keys(fleetActionRoutes), files: true, uploads: true },
);
let fileClockOffset = 0;
const files = new FleetWorkspaceFiles(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
  () => performance.now() + fileClockOffset,
);
const fileProof = new FleetProof(db, destination.identity, secrets);
const uploads = new FleetWorkspaceUploads(
  db,
  destination,
  credentials,
  OWNER,
  secrets,
  uploadFile,
  () => performance.now() + fileClockOffset,
);
const initial = {
  harness: "codex" as const,
  version: "fixture",
  project: root,
  billing: { mode: "existing" as const, description: "Isolated fixture" },
  capabilities: {
    approvals: true,
    questions: true,
    resume: true,
    liveAttach: false,
    terminal: false,
  },
};
const destinationPairing = new FleetPairing(
  db,
  destination,
  OWNER,
  process.env.LOOP55_DATA_DIR,
);
const host = new Host(process.env.LOOP55_DATA_DIR, initial, destinationPairing);
host.workspace = {
  http: app,
  peerHttp: createFleetPeerHttp(
    new FleetEnrollmentDestination(
      db,
      destination,
      destinationPairing,
      OWNER,
      secrets,
      () => origin,
    ),
    () => origin,
    {
      workspaceActions: actions,
      workspaceRead: reads,
      workspaceFiles: files,
      workspaceUploads: uploads,
      credentials,
    },
  ),
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
type Reply = { status: number; headers: IncomingHttpHeaders; body: any };
function http(
  port: number,
  origin: string,
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        signal,
        headers: {
          host: new URL(origin).host,
          "content-type": "application/json",
          ...(payload === undefined
            ? {}
            : { "content-length": Buffer.byteLength(payload) }),
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
let actionCalls = 0,
  probeCalls = 0,
  loseReply = false,
  holdProbe: Promise<void> | undefined;
let fileFault:
  | "unsigned"
  | "offset"
  | "bytes"
  | "hash"
  | "request"
  | "capability"
  | "probe"
  | "next-probe"
  | "upload-withdrawn"
  | undefined;
const fileCalls: { path: string; offset?: number }[] = [];
let holdChunk: Promise<void> | undefined,
  chunkStarted = false;
let loseUploadReply = false,
  uploadCommits = 0,
  corruptUploadChunk = false;
let holdUploadChunk: Promise<void> | undefined,
  uploadChunkStarted = false;
const fetcher: typeof undiciFetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe(origin);
  const headers = new Headers(init?.headers);
  const sent = JSON.parse(String(init?.body));
  fileCalls.push({ path: url.pathname, offset: sent.offset });
  for (const name of [
    "cookie",
    "authorization",
    "origin",
    "x-loop55-csrf",
    "x-loop55-owner",
    "x-loop55-command-id",
  ])
    expect(headers.has(name)).toBe(false);
  const action = url.pathname === "/api" + fleetWorkspaceActionApi.action.path;
  if (action) actionCalls++;
  if (url.pathname === "/api" + fleetPeerApi.enrollmentProbe.path) {
    probeCalls++;
    if (holdProbe) await holdProbe;
  }
  if (url.pathname === "/api" + fleetWorkspaceFileApi.chunk.path && holdChunk) {
    chunkStarted = true;
    await holdChunk;
  }
  if (
    url.pathname === "/api" + fleetWorkspaceUploadApi.chunk.path &&
    holdUploadChunk
  ) {
    uploadChunkStarted = true;
    await holdUploadChunk;
  }
  const response = await http(
    host.port,
    origin,
    url.pathname,
    "POST",
    JSON.parse(String(init?.body)),
    { "x-loop55-fleet-version": "1" },
    init?.signal ?? undefined,
  );
  if (action && loseReply)
    throw new TypeError("Fixture response lost after acceptance");
  if (url.pathname === "/api" + fleetWorkspaceUploadApi.commit.path) {
    uploadCommits++;
    if (loseUploadReply)
      throw new TypeError("Fixture upload reply lost after commit");
  }
  if (response.status === 200) {
    const body = response.body;
    if (
      corruptUploadChunk &&
      url.pathname === "/api" + fleetWorkspaceUploadApi.chunk.path
    ) {
      body.response.nextOffset++;
      body.signature = fileProof.sign("workspace-upload-chunk", body.response);
    }
    if (fileFault === "probe" && body.probe)
      body.signature = "a".repeat(85) + "A";
    if (fileFault === "upload-withdrawn" && body.catalog) {
      body.catalog.actions = body.catalog.actions.filter(
        (action: string) => action !== "uploadCreate",
      );
      body.signature = fileProof.sign("workspace-catalog", body.catalog);
    }
    if (fileFault === "capability" && body.catalog) {
      body.catalog.files = false;
      body.signature = fileProof.sign("workspace-catalog", body.catalog);
    }
    const opened = url.pathname === "/api" + fleetWorkspaceFileApi.open.path;
    const chunk = url.pathname === "/api" + fleetWorkspaceFileApi.chunk.path;
    if ((opened || chunk) && body.response) {
      if (fileFault === "hash") {
        if (opened) body.response.file.checksum = "0".repeat(64);
        else body.response.checksum = "0".repeat(64);
      }
      if (chunk && fileFault === "offset") body.response.offset++;
      if (chunk && fileFault === "bytes") body.response.base64 = "YQ==";
      if (chunk && fileFault === "request")
        body.response.requestId = randomUUID();
      if (fileFault && fileFault !== "unsigned")
        body.signature = fileProof.sign(
          opened ? "workspace-file-open" : "workspace-file-chunk",
          body.response,
        );
      if (chunk && fileFault === "unsigned") body.response.base64 = "YQ==";
      if (chunk && fileFault === "next-probe") fileFault = "probe";
    }
  }
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};
const leases = new FleetCredentialLeases(
  source,
  sourceCredentials,
  owner,
  new FleetCredentialHttpTransport(fetcher),
);
const peerReads = new FleetPeerReads(
  source,
  leases,
  owner,
  new FleetWorkspaceHttpTransport(fetcher),
);
const peerActions = new FleetPeerActions(
  sourceDb,
  source,
  leases,
  owner,
  new FleetWorkspaceActionHttpTransport(fetcher),
);
const peerFiles = new FleetPeerFiles(
  source,
  leases,
  owner,
  new FleetWorkspaceFileHttpTransport(fetcher),
);
const peerUploads = new FleetPeerUploads(
  sourceDb,
  source,
  leases,
  owner,
  new FleetWorkspaceUploadHttpTransport(fetcher),
);
const destinationLeases = new FleetCredentialLeases(
  destination,
  credentials,
  OWNER,
  new FleetCredentialHttpTransport(fetcher),
);
const destinationPeerActions = new FleetPeerActions(
  db,
  destination,
  destinationLeases,
  OWNER,
  new FleetWorkspaceActionHttpTransport(fetcher),
);
host.workspace.fleetCommandsHttp = createFleetCommandsHttp(
  destinationPairing,
  destinationPeerActions,
  actions,
  undefined,
  uploads,
);
const sourceAdapter = fleetAgentSource(
  source,
  owner,
  peerReads,
  peerActions,
  peerFiles,
  peerUploads,
);
const sourcePairing = new FleetPairing(
  sourceDb,
  source,
  owner,
  join(root, "gateway"),
);
const gateway = new Host(join(root, "gateway"), initial, sourcePairing);
let localCalls = 0;
gateway.workspace = {
  fleetCommandsHttp: createFleetCommandsHttp(
    sourcePairing,
    peerActions,
    undefined,
    peerUploads,
  ),
  sources: new AgentSources([sourceAdapter]),
  http: (_req, res) => {
    localCalls++;
    res.writeHead(404);
    res.end("{}");
  },
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
const peer = destination.identity.machineId;
const prefix = `/api/agent-sources/${encodeURIComponent("peer:" + peer)}`;
const connectionId = randomUUID(),
  foreignAgent = randomUUID();
let cookie = "",
  csrf = "";
async function pair() {
  const value = fleetDeviceFromLink(gateway.pair().url, gatewayOrigin);
  const paired = await http(
    gateway.port,
    gatewayOrigin,
    "/pair",
    "POST",
    { ...value, name: "Fixture phone" },
    { origin: gatewayOrigin },
  );
  expect(paired.status).toBe(200);
  cookie = paired.headers["set-cookie"]![0].split(";")[0];
  const session = await http(
    gateway.port,
    gatewayOrigin,
    "/session",
    "GET",
    undefined,
    { cookie },
  );
  csrf = session.body.csrf;
}
const browser = (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  http(gateway.port, gatewayOrigin, path, method, body, {
    cookie,
    origin: gatewayOrigin,
    "x-loop55-csrf": csrf,
    ...headers,
  });
type Download = {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: Buffer;
  complete: boolean;
};
function download(path: string, signal?: AbortSignal): Promise<Download> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: gateway.port,
        path: prefix + path,
        method: "GET",
        signal,
        headers: { host: new URL(gatewayOrigin).host, cookie },
      },
      (res) => {
        const chunks: Buffer[] = [];
        const finish = (complete: boolean) =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
            complete,
          });
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => finish(true));
        res.on("error", () => finish(false));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const fileSelection = (id: string) => ({
  route: "objectFile" as const,
  params: { id },
  query: {},
});
const uploadManifest = (bytes: Buffer) =>
  FleetUploadInput.parse({
    route: "uploadCreate",
    params: {},
    body: {
      options: {},
      file: {
        name: "résumé.txt",
        mime: "text/plain",
        size: bytes.length,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  });
async function browserUpload(
  input: FleetUploadInput,
  bytes: Buffer | undefined,
  id: string,
  extra: Record<string, string> = {},
): Promise<Reply> {
  const form = new FormData();
  form.set("manifest", JSON.stringify(input));
  if (bytes) form.set("file", new Blob([new Uint8Array(bytes)]), "upload");
  const encoded = new Request("http://fixture.invalid", {
    method: "POST",
    body: form,
  });
  const body = Buffer.from(await encoded.arrayBuffer());
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: gateway.port,
        path: prefix + "/uploads",
        method: "POST",
        headers: {
          host: new URL(gatewayOrigin).host,
          cookie,
          origin: gatewayOrigin,
          "x-loop55-csrf": csrf,
          "x-loop55-command-id": id,
          "content-type": encoded.headers.get("content-type")!,
          "content-length": String(body.length),
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const object = (
  bytes: Buffer,
  mime = "application/octet-stream",
  name = "fixture.bin",
) => uploadFile(OWNER, { originalname: name, mimetype: mime, buffer: bytes });
const createBody = () => ({
  name: "source-" + randomUUID().slice(0, 8),
  connectionId,
  model: "fixture",
});
beforeAll(async () => {
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture','','connected',?,'{}',0)",
  ).run(connectionId, OWNER, JSON.stringify([{ id: "fixture" }]));
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(?,?,'Foreign','foreign','openai','fixture','untouched','loop55',0)",
  ).run(foreignAgent, foreignOwner);
  await host.listen();
  host.setOrigin(origin);
  await gateway.listen();
  gateway.setOrigin(gatewayOrigin);
  await pair();
});
afterAll(async () => {
  peerUploads.close();
  uploads.close();
  peerFiles.close();
  files.close();
  destinationPeerActions.close();
  destinationLeases.close();
  peerActions.close();
  peerReads.close();
  leases.close();
  reads.close();
  actions.close();
  await gateway.close();
  await host.close();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  sourceDb.close();
  rmSync(root, { recursive: true, force: true });
});

it("discovers only this Host's enrolled peers without contact and projects their local source", async () => {
  const before = probeCalls;
  expect((await browser("/api/agent-sources")).body).toEqual([
    { id: "peer:" + peer, name: "Remote", kind: "peer" },
  ]);
  expect(probeCalls).toBe(before);
  expect(await new AgentSources([]).discover()).toEqual([]);
  const another = new AgentSources([
    fleetAgentSource(source, foreignOwner, peerReads, peerActions),
  ]);
  expect(await another.discover()).toEqual([]);
  const capabilities = await browser(prefix + "/capabilities");
  expect(capabilities.status).toBe(200);
  expect(capabilities.body).toMatchObject({
    profile: "companion",
    pairedDevices: false,
    runtimeHosts: false,
    cardTokens: false,
    fleet: {
      version: 1,
      machineId: peer,
      events: false,
      files: true,
      actions: [...Object.keys(fleetActionRoutes), "uploadCreate"],
    },
  });
  expect(capabilities.body.fleet.reads).toContain("agentSuggestName");
  expect((await browser(prefix + "/agents/suggest-name")).body.name).toEqual(
    expect.any(String),
  );
  const bootstrap = await browser(prefix + "/bootstrap");
  expect(bootstrap.status).toBe(200);
  expect(JSON.stringify(bootstrap.body)).not.toContain(foreignAgent);
  expect(bootstrap.headers["x-loop55-change-epoch"]).toEqual(
    expect.any(String),
  );
  expect(localCalls).toBe(0);
});

it("pages complete remote Done groups and destinations without crossing owners or stale membership", async () => {
  const agent = randomUUID(),
    conversation = randomUUID(),
    group = randomUUID();
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,'Large group',?,'openai','fixture',1)",
  ).run(agent, OWNER, agent);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Large group',1)",
  ).run(conversation, OWNER, agent);
  const content = "Complete result. ".repeat(1536);
  const cards = Array.from({ length: 100 }, (_, index) => {
    const run = randomUUID();
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'Task','completed',?,?,?)",
    ).run(run, OWNER, agent, conversation, run, index + 1, index + 2);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,'{}',?)",
    ).run(run, OWNER, conversation, run, content + index, index + 2);
    return "d:run:" + run;
  });
  const created = await browser(
    prefix + "/feed/threads",
    "POST",
    { id: group, title: "Large group", cardIds: cards },
    { "x-loop55-command-id": group },
  );
  expect(created.status).toBe(200);
  const pageRequests: string[] = [];
  const reader = contractDoneThreadReader(async (contract, input, signal) => {
    signal?.throwIfAborted();
    const path = routePath(contract, input);
    pageRequests.push(path);
    const response = await browser(prefix + path);
    expect(response.status).toBe(200);
    expect(
      Buffer.byteLength(JSON.stringify(response.body)),
    ).toBeLessThanOrEqual(DONE_THREAD_PAGE_BYTES);
    return response.body;
  });
  const detail = await reader.detail(group);
  expect(pageRequests.length).toBeGreaterThan(1);
  expect(detail.cards.map((card) => card.id)).toEqual(cards);
  expect(detail.cards.map((card) => card.content)).toEqual(
    cards.map((_, index) => content + index),
  );
  // A small member count can still exceed the byte budget. Preserve each
  // complete card while stopping the page before that budget is crossed.
  const larger = content.repeat(25);
  for (let index = 0; index < 3; index++)
    db.prepare("UPDATE messages SET content=? WHERE id=?").run(
      larger + index,
      cards[index].slice("d:run:".length),
    );
  const bytePage = await browser(prefix + `/feed/threads/${group}/page`);
  expect(bytePage.status).toBe(200);
  expect(bytePage.body.cards.length).toBeLessThan(20);
  expect(Buffer.byteLength(JSON.stringify(bytePage.body))).toBeLessThanOrEqual(
    DONE_THREAD_PAGE_BYTES,
  );
  const largerDetail = await reader.detail(group);
  expect(largerDetail.cards.map((card) => card.content)).toEqual(
    cards.map((_, index) => (index < 3 ? larger : content) + index),
  );
  const first = await browser(prefix + `/feed/threads/${group}/page`);
  expect(first.status).toBe(200);
  expect(first.body.next).toEqual(expect.any(String));
  const destinations = [group];
  for (let index = 0; index < 24; index++) {
    const id = randomUUID();
    destinations.push(id);
    expect(
      (
        await browser(
          prefix + "/feed/threads",
          "POST",
          {
            id,
            title: "Destination " + index,
            cardIds: cards.slice(index * 2, index * 2 + 2),
          },
          { "x-loop55-command-id": id },
        )
      ).status,
    ).toBe(200);
  }
  const stale = await browser(
    prefix +
      `/feed/threads/${group}/page?cursor=${encodeURIComponent(first.body.next)}`,
  );
  expect(stale.status).toBe(409);
  expect(
    (await browser(prefix + `/feed/threads/${group}/page?cursor=invalid`))
      .status,
  ).toBe(400);
  const privateGroup = randomUUID();
  db.prepare(
    "INSERT INTO done_threads(id,owner_id,title,created_at) VALUES(?,?,'Private',1)",
  ).run(privateGroup, foreignOwner);
  expect(
    (await browser(prefix + `/feed/threads/${privateGroup}/page`)).status,
  ).toBe(404);
  const listStart = pageRequests.length;
  const listed = await reader.list();
  expect(pageRequests.length - listStart).toBeGreaterThan(1);
  expect(listed.map((thread) => thread.id).sort()).toEqual(destinations.sort());
  expect(JSON.stringify(listed)).not.toContain(privateGroup);
  expect(listed.find((thread) => thread.id === group)?.cardIds).toHaveLength(
    52,
  );
  expect(
    (
      await browser(
        prefix +
          `/feed/threads/${group}/cards/${encodeURIComponent(cards[99])}`,
        "DELETE",
        undefined,
        { "x-loop55-command-id": randomUUID() },
      )
    ).status,
  ).toBe(200);
  expect((await reader.detail(group)).cards.map((card) => card.id)).toEqual(
    cards.slice(48, 99),
  );
  // One indivisible result cannot fit a page: preserve a bounded 413 through
  // the actual owning app, peer transport and paired gateway.
  db.prepare("UPDATE messages SET content=? WHERE id=?").run(
    "x".repeat(DONE_THREAD_PAGE_BYTES),
    cards[48].slice("d:run:".length),
  );
  const oversized = await browser(prefix + `/feed/threads/${group}/page`);
  expect(oversized.status).toBe(413);
  expect(Buffer.byteLength(JSON.stringify(oversized.body))).toBeLessThan(1024);
}, 15_000);

it("loads, pages and refreshes remote Done cards through the paired gateway without exposing another owner", async () => {
  const agent = randomUUID(),
    privateAgent = randomUUID();
  for (const [id, account] of [
    [agent, OWNER],
    [privateAgent, foreignOwner],
  ])
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,'Cards',?,'openai','fixture',1)",
    ).run(id, account, id);
  function completed(account: string, selectedAgent: string, at: number) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Fleet card',1)",
    ).run(id, account, selectedAgent);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'Fleet card','completed',?,?,?)",
    ).run(id, account, selectedAgent, id, id, at, at);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','Fleet answer','{}',?)",
    ).run(id, account, id, id, at);
    return id;
  }
  const older = completed(OWNER, agent, 10),
    newer = completed(OWNER, agent, 20),
    privateRun = completed(foreignOwner, privateAgent, 30);
  const request: Parameters<typeof contractCardReader>[0] = async (
    contract,
    selection,
  ) => {
    const path = routePath(contract, selection);
    const pageSize =
      contract.path === "/v1/cards"
        ? (path.includes("?") ? "&" : "?") + "limit=1"
        : "";
    const response = await browser(prefix + path + pageSize);
    if (response.status !== 200)
      throw Object.assign(new Error("Remote Cards request failed"), {
        status: response.status,
      });
    return response.body;
  };
  const reader = new DoneCardsReader(peer + ":done");
  const selection = { view: "done" as const, agent };
  const first = await reader.load(request, selection, false);
  expect(first?.page.items.map((entry) => entry.card.id)).toEqual([
    "d:run:" + newer,
  ]);
  expect(first?.page.next).toEqual(expect.any(String));
  const next = await reader.load(request, selection, true);
  expect(next?.page.items.map((entry) => entry.card.id)).toEqual([
    "d:run:" + newer,
    "d:run:" + older,
  ]);
  db.prepare(
    "UPDATE messages SET content='Updated fleet answer' WHERE id=?",
  ).run(newer);
  const updated = await reader.load(request, selection, false);
  expect(updated?.page.items[0].card.content).toBe("Updated fleet answer");
  const cards = contractCardReader(request);
  expect((await cards.detail("d:run:" + older)).content).toBe("Fleet answer");
  const all = await cards.list({ view: "done" });
  expect(all.items.map((entry) => entry.card.id)).not.toContain(
    "d:run:" + privateRun,
  );
  await expect(cards.detail("d:run:" + privateRun)).rejects.toMatchObject({
    status: 404,
  });
  const readCommand = randomUUID();
  const markRead = () =>
    browser(
      prefix + `/feed/${newer}/read`,
      "PUT",
      { cardKey: "run:" + newer },
      { "x-loop55-command-id": readCommand },
    );
  expect((await markRead()).status).toBe(200);
  const readCard = await cards.detail("d:run:" + newer);
  expect(readCard.type === "done" && readCard.display.read_at).toEqual(
    expect.any(Number),
  );
  expect((await markRead()).status).toBe(200);
  expect(await cards.detail("d:run:" + newer)).toEqual(readCard);
  const createGroup = (id: string) =>
    browser(
      prefix + "/feed/threads",
      "POST",
      {
        id,
        title: "Remote done group",
        cardIds: ["d:run:" + older, "d:run:" + newer],
      },
      { "x-loop55-command-id": id },
    );
  const group = randomUUID();
  expect((await createGroup(group)).status).toBe(200);
  expect(
    (
      await browser(
        prefix + `/feed/threads/${group}/read`,
        "PUT",
        {},
        { "x-loop55-command-id": randomUUID() },
      )
    ).status,
  ).toBe(200);
  const groupRead = await browser(prefix + `/feed/threads/${group}`);
  expect(groupRead.status).toBe(200);
  expect(
    groupRead.body.cards.map(
      (card: { display: { read_at: unknown } }) => card.display.read_at,
    ),
  ).toEqual([expect.any(Number), expect.any(Number)]);
  const groupUnreadCommand = randomUUID();
  const invalidUnread = await browser(
    prefix + `/feed/threads/${group}/read`,
    "DELETE",
    { unexpected: true },
    { "x-loop55-command-id": randomUUID() },
  );
  expect(invalidUnread.status).toBe(400);
  expect((await browser(prefix + `/feed/threads/${group}`)).body).toEqual(
    groupRead.body,
  );
  const markGroupUnread = () =>
    browser(prefix + `/feed/threads/${group}/read`, "DELETE", undefined, {
      "x-loop55-command-id": groupUnreadCommand,
    });
  const unreadGroup = await markGroupUnread();
  expect(unreadGroup.status).toBe(200);
  expect(
    (await browser(prefix + `/feed/threads/${group}`)).body.cards.map(
      (card: { display: { read_at: unknown } }) => card.display.read_at,
    ),
  ).toEqual([null, null]);
  expect(
    (
      await browser(
        prefix + `/feed/threads/${group}/read`,
        "PUT",
        { unreadVersions: unreadGroup.body.unreadVersions },
        { "x-loop55-command-id": randomUUID() },
      )
    ).status,
  ).toBe(200);
  const reopenedGroup = await browser(prefix + `/feed/threads/${group}`);
  expect(
    reopenedGroup.body.cards.map(
      (card: { display: { read_at: unknown } }) => card.display.read_at,
    ),
  ).toEqual([expect.any(Number), expect.any(Number)]);
  // An earlier unread receipt cannot overwrite the user's later group read.
  expect((await markGroupUnread()).body).toEqual(unreadGroup.body);
  expect((await browser(prefix + `/feed/threads/${group}`)).body).toEqual(
    reopenedGroup.body,
  );
  const removeMember = () =>
    browser(
      prefix +
        `/feed/threads/${group}/cards/${encodeURIComponent("d:run:" + older)}`,
      "DELETE",
      undefined,
      { "x-loop55-command-id": removeMemberId },
    );
  const removeMemberId = randomUUID();
  const removedMember = await removeMember();
  expect(removedMember.status).toBe(200);
  expect((await removeMember()).body).toEqual(removedMember.body);
  // Groups with fewer than two members dissolve through the owning handler.
  expect((await browser(prefix + `/feed/threads/${group}`)).status).toBe(404);
  const groupToRemove = randomUUID();
  expect((await createGroup(groupToRemove)).status).toBe(200);
  const removeGroupId = randomUUID();
  const removeGroup = () =>
    browser(prefix + `/feed/threads/${groupToRemove}`, "DELETE", undefined, {
      "x-loop55-command-id": removeGroupId,
    });
  const removedGroup = await removeGroup();
  expect(removedGroup.status).toBe(200);
  expect((await removeGroup()).body).toEqual(removedGroup.body);
  expect(
    (await browser(prefix + `/feed/threads/${groupToRemove}`)).status,
  ).toBe(404);
  const unreadCommand = randomUUID();
  const markUnread = () =>
    browser(
      prefix + `/feed/${newer}/read`,
      "DELETE",
      { cardKey: "run:" + newer },
      { "x-loop55-command-id": unreadCommand },
    );
  expect((await markUnread()).status).toBe(200);
  const unreadCard = await cards.detail("d:run:" + newer);
  expect(unreadCard.type === "done" && unreadCard.display.read_at).toBeNull();
  expect(
    (
      await browser(
        prefix + `/feed/${newer}/read`,
        "PUT",
        {
          cardKey: "run:" + newer,
          unreadVersion:
            unreadCard.type === "done"
              ? unreadCard.display.unread_version
              : undefined,
        },
        { "x-loop55-command-id": randomUUID() },
      )
    ).status,
  ).toBe(200);
  const reopenedCard = await cards.detail("d:run:" + newer);
  expect(reopenedCard.type === "done" && reopenedCard.display.read_at).toEqual(
    expect.any(Number),
  );
  // Recovering the earlier command returns its receipt without overwriting
  // the user's later read decision.
  expect((await markUnread()).status).toBe(200);
  expect(await cards.detail("d:run:" + newer)).toEqual(reopenedCard);
  const refused = await browser(
    prefix + `/feed/${privateRun}/read`,
    "DELETE",
    { cardKey: "run:" + privateRun },
    { "x-loop55-command-id": randomUUID() },
  );
  expect(refused.status).toBe(409);
  expect(refused.headers["x-loop55-command-state"]).toBe("refused");
  expect(refused.body.executionOutcome).toBe("refused");
  expect(
    db
      .prepare("SELECT unread FROM feed_cards WHERE owner_id=? AND card_key=?")
      .get(foreignOwner, "run:" + privateRun),
  ).toEqual({ unread: 1 });
  const capabilities = await browser(prefix + "/capabilities");
  expect(capabilities.body.fleet.reads).toEqual(
    expect.arrayContaining(["cardList", "cardChanges", "cardDetail"]),
  );
  expect(capabilities.body.fleet.actions).toEqual(
    expect.arrayContaining([
      "feedRead",
      "feedUnread",
      "doneThreadRead",
      "doneThreadUnread",
    ]),
  );
});

it("streams verified owning bytes through the paired source and releases its snapshot", async () => {
  const bytes = randomBytes(FLEET_FILE_CHUNK_BYTES * 2 + 17),
    file = object(bytes);
  const before = fileCalls.length,
    received = await download("/objects/" + file.objectId);
  expect(received).toMatchObject({ status: 200, complete: true });
  expect(received.bytes.equals(bytes)).toBe(true);
  expect(received.headers["content-length"]).toBe(String(bytes.length));
  expect(received.headers["cache-control"]).toBe("private, no-store");
  expect(received.headers).not.toHaveProperty("set-cookie");
  const chunks = fileCalls
    .slice(before)
    .filter((value) => value.path.endsWith("/file/chunk"));
  expect(chunks.map((value) => value.offset)).toEqual([
    0,
    FLEET_FILE_CHUNK_BYTES,
    FLEET_FILE_CHUNK_BYTES * 2,
  ]);
  await until(() =>
    fileCalls
      .slice(before)
      .some(
        (value) => value.path === "/api" + fleetWorkspaceFileApi.close.path,
      ),
  );
  expect(localCalls).toBe(0);
});

it("streams an owning publication through the download alias without redirects", async () => {
  const bytes = Buffer.from("Published file fixture");
  const published = saveArtifact(OWNER, {
    title: "Published",
    kind: "file",
    content: "fixture",
    metadata: { name: "published.txt", mime: "text/plain" },
  });
  const key = `objects/${"a".repeat(64)}/${randomUUID()}/${"b".repeat(64)}`;
  const path = join(process.env.LOOP55_DATA_DIR!, key);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  db.prepare("INSERT INTO artifact_objects VALUES(?,?,?,?,?,?,?,?)").run(
    published,
    OWNER,
    randomUUID(),
    randomUUID(),
    key,
    "text/plain",
    bytes.length,
    createHash("sha256").update(bytes).digest("base64"),
  );
  const alias = await download(`/artifacts/${published}/download`);
  expect(alias).toMatchObject({ status: 200, complete: true, bytes });
  expect(alias.headers["content-security-policy"]).toBe(
    "default-src 'none'; sandbox",
  );
  expect(alias.headers).not.toHaveProperty("location");
  expect(
    (await download(`/artifacts/${published}/download?preview=html`)).status,
  ).toBe(400);
  expect(localCalls).toBe(0);
});

it("keeps HTML previews sandboxed and rejects foreign or invalid file selections", async () => {
  const html = object(
    Buffer.from("<button onclick='window.x=1'>Preview</button>"),
    "text/html",
    "preview.html",
  );
  const preview = await download(`/objects/${html.objectId}?preview=html`);
  expect(preview.status).toBe(200);
  expect(preview.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(preview.headers["content-security-policy"]).toContain(
    "sandbox allow-scripts",
  );
  expect(preview.headers["content-security-policy"]).not.toContain(
    "allow-same-origin",
  );
  expect(preview.headers["content-security-policy"]).toContain(
    "connect-src 'none'",
  );
  const raw = await download(`/objects/${html.objectId}`);
  expect(raw.status).toBe(200);
  expect(raw.headers["content-security-policy"]).toBe(
    "default-src 'none'; sandbox",
  );
  const empty = object(Buffer.alloc(0));
  expect(await download("/objects/" + empty.objectId)).toMatchObject({
    status: 200,
    complete: true,
    bytes: Buffer.alloc(0),
  });
  const nonHtml = await download(`/objects/${empty.objectId}?preview=html`);
  expect(nonHtml.status).toBe(200);
  expect(nonHtml.headers["content-security-policy"]).toBe(
    "default-src 'none'; sandbox",
  );
  const foreign = uploadFile(foreignOwner, {
    originalname: "foreign",
    mimetype: "text/plain",
    buffer: Buffer.from("private"),
  });
  expect((await download("/objects/" + foreign.objectId)).status).toBe(404);
  expect(
    (await download(`/objects/${html.objectId}?preview=1&preview=html`)).status,
  ).toBe(400);
  expect(
    (await download(`/objects/${html.objectId}?owner=${foreignOwner}`)).status,
  ).toBe(400);
  expect(localCalls).toBe(0);
});

it("rejects unsigned and signed malformed file chunks without emitting their bytes", async () => {
  const file = object(randomBytes(FLEET_FILE_CHUNK_BYTES + 17));
  try {
    for (const fault of ["unsigned", "offset", "bytes", "request"] as const) {
      fileFault = fault;
      const received = await download("/objects/" + file.objectId);
      expect(received.status).toBe(502);
      expect(received.complete).toBe(true);
      expect(JSON.parse(received.bytes.toString()).error).toContain("verified");
    }
  } finally {
    fileFault = undefined;
  }
});

it("withholds the final chunk when a signed manifest has the wrong whole-file checksum", async () => {
  const bytes = randomBytes(FLEET_FILE_CHUNK_BYTES + 17),
    file = object(bytes);
  fileFault = "hash";
  try {
    const received = await download("/objects/" + file.objectId);
    expect(received).toMatchObject({ status: 200, complete: false });
    expect(
      received.bytes.equals(bytes.subarray(0, FLEET_FILE_CHUNK_BYTES)),
    ).toBe(true);
    expect(received.bytes.length).toBeLessThan(
      Number(received.headers["content-length"]),
    );
  } finally {
    fileFault = undefined;
  }
});

it("checks signed file capabilities and fresh destination identity before opening a transfer", async () => {
  const file = object(Buffer.from("fixture"));
  try {
    fileFault = "capability";
    let before = fileCalls.length;
    expect((await download("/objects/" + file.objectId)).status).toBe(409);
    expect(
      fileCalls
        .slice(before)
        .some((value) => value.path.endsWith("/file/open")),
    ).toBe(false);
    fileFault = "probe";
    before = fileCalls.length;
    expect((await download("/objects/" + file.objectId)).status).toBe(403);
    expect(fileCalls.slice(before).map((value) => value.path)).toEqual([
      "/api" + fleetPeerApi.enrollmentProbe.path,
    ]);
  } finally {
    fileFault = undefined;
  }
});

it("rechecks destination identity between chunks without sending a credential to a replacement", async () => {
  const file = object(randomBytes(FLEET_FILE_CHUNK_BYTES + 17));
  const before = fileCalls.length;
  fileFault = "next-probe";
  try {
    const received = await download("/objects/" + file.objectId);
    expect(received).toMatchObject({ status: 200, complete: false });
    expect(received.bytes.length).toBe(FLEET_FILE_CHUNK_BYTES);
    const calls = fileCalls.slice(before),
      chunk = calls.findIndex((value) => value.path.endsWith("/file/chunk"));
    expect(calls.slice(chunk + 1).map((value) => value.path)).toEqual([
      "/api" + fleetPeerApi.enrollmentProbe.path,
    ]);
  } finally {
    fileFault = undefined;
    // A failed identity probe deliberately sends no cleanup credential. Let the
    // destination's normal idle expiry reclaim this unreachable snapshot before
    // the next fixture checks its two-transfer capacity.
    fileClockOffset += 30_001;
  }
});

it("applies consumer backpressure and bounds concurrent file downloads", async () => {
  const bytes = randomBytes(FLEET_FILE_CHUNK_BYTES + 1),
    file = object(bytes);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  const receive = {
    start: () => {},
    write: async () => {
      held++;
      await paused;
    },
  };
  const first = peerFiles.download(peer, fileSelection(file.objectId), receive);
  const second = peerFiles.download(
    peer,
    fileSelection(file.objectId),
    receive,
  );
  void first.catch(() => {});
  void second.catch(() => {});
  try {
    await until(() => held === 2);
    const before = fileCalls.length;
    await expect(
      peerFiles.download(peer, fileSelection(file.objectId), {
        start: () => {},
        write: () => {},
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fileCalls.length).toBe(before);
    expect(
      fileCalls
        .filter((value) => value.path.endsWith("/file/chunk"))
        .slice(-2)
        .every((value) => value.offset === 0),
    ).toBe(true);
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

it("sign-out aborts a held file chunk without exposing it and frees download capacity", async () => {
  const file = object(Buffer.from("held fixture"));
  let release!: () => void;
  holdChunk = new Promise((resolve) => {
    release = resolve;
  });
  chunkStarted = false;
  const pending = download("/objects/" + file.objectId).catch((error) => error);
  try {
    await until(() => chunkStarted);
    expect((await browser("/api/auth/sign-out", "POST", {})).status).toBe(200);
    expect(await pending).toBeInstanceOf(Error);
  } finally {
    holdChunk = undefined;
    release();
    await pair();
  }
  expect(await download("/objects/" + file.objectId)).toMatchObject({
    status: 200,
    complete: true,
    bytes: Buffer.from("held fixture"),
  });
});

it("preserves one command through the browser source route, lost response and receipt reconciliation", async () => {
  const id = randomUUID(),
    body = createBody(),
    before = actionCalls;
  loseReply = true;
  const uncertain = await browser(prefix + "/agents", "POST", body, {
    "x-loop55-command-id": id,
    "x-loop55-owner": foreignOwner,
  });
  expect(uncertain.status).toBe(503);
  expect(uncertain.body.executionOutcome).toBe("unknown");
  expect(uncertain.headers["x-loop55-command-id"]).toBe(id);
  expect(uncertain.headers["x-loop55-command-state"]).toBe("unknown");
  loseReply = false;
  const complete = await browser(prefix + "/agents", "POST", body, {
    "x-loop55-command-id": id,
    "x-loop55-receipt-only": "1",
  });
  expect(complete.status).toBe(201);
  expect(complete.headers["x-loop55-command-id"]).toBe(id);
  expect(complete.headers["x-loop55-command-state"]).toBe("completed");
  expect(complete.body.name).toBe(body.name);
  expect(actionCalls - before).toBe(1);
  expect(
    db.prepare("SELECT owner_id FROM agents WHERE id=?").get(complete.body.id),
  ).toEqual({ owner_id: OWNER });
  expect(
    sourceDb
      .prepare(
        "SELECT state FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
      )
      .get(owner, id),
  ).toEqual({ state: "completed" });
  const different = await browser(prefix + "/agents", "POST", createBody(), {
    "x-loop55-command-id": id,
  });
  expect(different.status).toBeGreaterThanOrEqual(400);
  expect(actionCalls - before).toBe(1);
});

it.each(["move", "reorder", "withdraw", "cancel"] as const)(
  "routes a queued run's %s operation through its owning handler and receipt",
  async (operation) => {
    const created = await browser(prefix + "/agents", "POST", createBody(), {
      "x-loop55-command-id": randomUUID(),
    });
    expect(created.status).toBe(201);
    const agent = created.body.id;
    const { enqueue } = await import("../src/server/queue.js");
    function queued() {
      const conversation = randomUUID();
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Queue routing fixture',1)",
      ).run(conversation, OWNER, agent);
      return enqueue(OWNER, "Queued routing fixture", randomUUID(), {
        agent,
        conversation,
        payload: { connectionId },
      });
    }
    const run = queued(),
      other = queued(),
      commandId = randomUUID();
    let target = agent;
    if (operation === "move") {
      const destination = await browser(
        prefix + "/agents",
        "POST",
        createBody(),
        {
          "x-loop55-command-id": randomUUID(),
        },
      );
      expect(destination.status).toBe(201);
      target = destination.body.id;
    }
    const body =
      operation === "move"
        ? { agentId: target }
        : operation === "reorder"
          ? { direction: "down" }
          : {};
    const before = actionCalls;
    const send = () =>
      browser(prefix + `/runs/${run.id}/${operation}`, "POST", body, {
        "x-loop55-command-id": commandId,
      });
    const first = await send();
    expect(first.status).toBe(operation === "move" ? 202 : 200);
    expect(first.headers["x-loop55-command-state"]).toBe("completed");
    expect(
      db
        .prepare(
          "SELECT state,command_tag FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
        )
        .get(OWNER, commandId),
    ).toEqual({
      state: "completed",
      command_tag:
        operation === "cancel"
          ? "runAction"
          : `run${operation[0].toUpperCase()}${operation.slice(1)}`,
    });
    if (operation === "reorder") {
      expect(
        db
          .prepare(
            "SELECT id FROM runs WHERE owner_id=? AND agent_id=? AND state='queued' ORDER BY COALESCE(queue_rank,created_at),rowid",
          )
          .all(OWNER, agent),
      ).toEqual([{ id: other.id }, { id: run.id }]);
    } else {
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "cancelled" });
      if (operation === "withdraw") expect(first.body.input).toBe(run.input);
      if (operation === "move") {
        expect(first.body.agent_id).toBe(target);
        expect(
          db
            .prepare(
              "SELECT count(*) n FROM runs WHERE owner_id=? AND idempotency_key=?",
            )
            .get(OWNER, commandId),
        ).toEqual({ n: 1 });
      }
    }
    expect((await send()).body).toEqual(first.body);
    expect(actionCalls).toBe(before + 1);
    expect(localCalls).toBe(0);
  },
);

it("refuses missing identities, foreign resources, arbitrary routes and cross-origin headers without local fallback", async () => {
  const before = actionCalls;
  expect((await browser(prefix + "/agents", "POST", createBody())).status).toBe(
    400,
  );
  for (const path of [
    "/teams",
    "/connections",
    "/agent-sources",
    "/fleet/admin/state",
    "/execution/dispatch",
  ])
    expect(
      (
        await browser(
          prefix + path,
          "POST",
          {},
          { "x-loop55-command-id": randomUUID() },
        )
      ).status,
    ).toBe(409);
  expect(
    (
      await browser(prefix + "/bootstrap", "GET", undefined, {
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(prefix + "/bootstrap", "GET", undefined, {
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(prefix + "/bootstrap", "GET", undefined, {
        "x-http-method-override": "POST",
      })
    ).status,
  ).toBe(403);
  expect(actionCalls).toBe(before);
  const foreign = await browser(
    prefix + "/agents/" + foreignAgent,
    "PATCH",
    { name: "changed" },
    { "x-loop55-command-id": randomUUID() },
  );
  expect(foreign.status).toBeGreaterThanOrEqual(400);
  expect(
    db.prepare("SELECT name FROM agents WHERE id=?").get(foreignAgent),
  ).toEqual({ name: "Foreign" });
  expect(localCalls).toBe(0);
});

it("isolated previews cannot use an injected peer source", async () => {
  const before = probeCalls;
  const original = { cookie, csrf };
  gateway.workspace!.isolated = true;
  try {
    expect((await browser(prefix + "/bootstrap")).status).toBe(401);
    await pair();
    expect((await browser(prefix + "/bootstrap")).status).toBe(403);
    expect((await browser("/api/agent-sources")).body).toEqual([]);
    expect(probeCalls).toBe(before);
  } finally {
    gateway.workspace!.isolated = false;
    cookie = original.cookie;
    csrf = original.csrf;
  }
});

it("revoking a browser during destination preparation closes the delegated request before any action", async () => {
  let release!: () => void;
  holdProbe = new Promise((resolve) => {
    release = resolve;
  });
  const before = actionCalls,
    probes = probeCalls,
    id = randomUUID(),
    body = createBody();
  const pending = browser(prefix + "/agents", "POST", body, {
    "x-loop55-command-id": id,
  }).catch((error) => error);
  await until(() => probeCalls > probes);
  expect((await browser("/api/auth/sign-out", "POST", {})).status).toBe(200);
  release();
  holdProbe = undefined;
  try {
    expect(await pending).toBeInstanceOf(Error);
    expect(actionCalls).toBe(before);
    await expect
      .poll(() =>
        sourceDb
          .prepare(
            "SELECT state FROM fleet_forwarded_actions WHERE command_id=?",
          )
          .get(id),
      )
      .toEqual({ state: "unknown" });
  } finally {
    await pair();
  }
  const refused = await browser(prefix + "/agents", "POST", body, {
    "x-loop55-command-id": id,
    "x-loop55-receipt-only": "1",
  });
  expect(refused.status).toBe(409);
  expect(refused.headers["x-loop55-command-state"]).toBe("refused");
  expect(actionCalls).toBe(before);
  const fresh = await browser(prefix + "/agents", "POST", body, {
    "x-loop55-command-id": randomUUID(),
  });
  expect(fresh.status).toBe(201);
  expect(actionCalls).toBe(before + 1);
});

it("a gateway origin change fences a prepared read without erasing another viewer's credential", async () => {
  const credential = await leases.get(peer, "read");
  let release!: () => void;
  holdProbe = new Promise((resolve) => {
    release = resolve;
  });
  const probes = probeCalls;
  const pending = browser(prefix + "/bootstrap").catch((error) => error);
  await until(() => probeCalls > probes);
  gatewayOrigin = "https://gateway-new.example";
  gateway.setOrigin(gatewayOrigin);
  release();
  holdProbe = undefined;
  expect(await pending).toBeInstanceOf(Error);
  expect((await leases.get(peer, "read")).token).toBe(credential.token);
  await pair();
});

const receiptPath = "/api/fleet/commands/receipt";
it("previews the remote recipient without a command and preserves one shared send through a lost reply", async () => {
  const created = await browser(prefix + "/agents", "POST", createBody(), {
    "x-loop55-command-id": randomUUID(),
  });
  expect(created.status).toBe(201);
  const agent = created.body;
  const before = actionCalls,
    localBefore = localCalls;
  const rows = sourceDb
    .prepare("SELECT count(*) n FROM fleet_forwarded_actions")
    .get();
  const suggested = await browser(prefix + "/routing/preview", "POST", {
    input: "@" + agent.name + " find a recipient",
  });
  expect(suggested.status).toBe(200);
  expect(suggested.body.agent.id).toBe(agent.id);
  const body = {
    question: "@" + agent.name + " inspect the shared content",
    source: {
      url: "https://example.invalid/unfetched",
      title: "Fixture",
      excerpt: "User-supplied text",
    },
  };
  const preview = await browser(prefix + "/share/preview", "POST", body);
  expect(preview.status).toBe(200);
  expect(preview.body.agent.id).toBe(agent.id);
  expect(preview.headers).not.toHaveProperty("x-loop55-command-id");
  expect(
    sourceDb.prepare("SELECT count(*) n FROM fleet_forwarded_actions").get(),
  ).toEqual(rows);
  expect(actionCalls).toBe(before);
  expect(localCalls).toBe(localBefore);
  expect(
    (
      await browser(prefix + "/share/preview", "POST", {
        ...body,
        question: "x".repeat(200_000),
      })
    ).status,
  ).toBe(413);
  const id = randomUUID();
  loseReply = true;
  try {
    expect(
      (
        await browser(prefix + "/share/send", "POST", body, {
          "x-loop55-command-id": id,
        })
      ).status,
    ).toBe(503);
  } finally {
    loseReply = false;
  }
  const receipt = await browser(prefix + "/share/send", "POST", body, {
    "x-loop55-command-id": id,
    "x-loop55-receipt-only": "1",
  });
  expect(receipt.status).toBe(200);
  expect(receipt.body.agent_id).toBe(agent.id);
  expect(receipt.headers["x-loop55-command-id"]).toBe(id);
  expect(actionCalls - before).toBe(1);
  expect(
    db.prepare("SELECT count(*) n FROM runs WHERE agent_id=?").get(agent.id),
  ).toEqual({ n: 1 });
  expect(
    db
      .prepare(
        "SELECT command_id FROM fleet_effect_authorizations WHERE effect_kind='run' AND effect_id=?",
      )
      .get(receipt.body.id),
  ).toEqual({ command_id: id });
  const conflict = await browser(
    prefix + "/share/send",
    "POST",
    { ...body, question: "changed" },
    { "x-loop55-command-id": id },
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.executionOutcome).toBe("unknown");
  expect(conflict.headers).not.toHaveProperty("x-loop55-command-state");
  expect(
    (
      await browser(
        prefix + "/share/send",
        "POST",
        { question: "Foreign recipient", newAgentId: foreignAgent },
        { "x-loop55-command-id": randomUUID() },
      )
    ).status,
  ).toBe(409);
  expect(
    db
      .prepare("SELECT count(*) n FROM runs WHERE agent_id=?")
      .get(foreignAgent),
  ).toEqual({ n: 0 });
});

it("recovers a committed command using only its original ID, route and digest through the paired Host", async () => {
  const id = randomUUID(),
    body = createBody(),
    before = actionCalls;
  const reference = {
    peer,
    commandId: id,
    route: "agentCreate" as const,
    payloadDigest: fleetPayloadDigest(
      fleetActionInput({ route: "agentCreate", params: {}, body }, id),
    ),
  };
  loseReply = true;
  try {
    expect(
      (
        await browser(prefix + "/agents", "POST", body, {
          "x-loop55-command-id": id,
        })
      ).status,
    ).toBe(503);
  } finally {
    loseReply = false;
  }
  const wrong = await browser(receiptPath, "POST", {
    ...reference,
    payloadDigest: "0".repeat(64),
  });
  expect(wrong.status).toBe(409);
  const receipt = await browser(receiptPath, "POST", reference);
  expect(receipt.status).toBe(200);
  expect(receipt.body).toMatchObject({
    commandId: id,
    state: "completed",
    result: { name: body.name },
  });
  expect(actionCalls - before).toBe(1);
  expect(
    db.prepare("SELECT count(*) n FROM agents WHERE name=?").get(body.name),
  ).toEqual({ n: 1 });
  // Explicitly open and pair the owning machine as the new gateway. This is a
  // new origin session; neither the old gateway cookie nor a peer credential
  // authorizes the local receipt endpoint.
  const value = fleetDeviceFromLink(host.pair().url, origin);
  const paired = await http(
    host.port,
    origin,
    "/pair",
    "POST",
    { ...value, name: "Recovered phone" },
    { origin },
  );
  expect(paired.status).toBe(200);
  const localCookie = paired.headers["set-cookie"]![0].split(";")[0];
  const session = await http(host.port, origin, "/session", "GET", undefined, {
    cookie: localCookie,
  });
  const localHeaders = {
    cookie: localCookie,
    origin,
    "x-loop55-csrf": session.body.csrf,
  };
  const calls = probeCalls;
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        reference,
        localHeaders,
      )
    ).body,
  ).toEqual(receipt.body);
  expect(
    (await http(host.port, origin, receiptPath, "POST", reference, { origin }))
      .status,
  ).toBe(401);
  expect(
    (
      await http(host.port, origin, receiptPath, "POST", reference, {
        ...localHeaders,
        "x-loop55-csrf": "wrong",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        { ...reference, route: "agentUpdate" },
        localHeaders,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        { ...reference, payloadDigest: "0".repeat(64) },
        localHeaders,
      )
    ).status,
  ).toBe(409);
  // An otherwise matching receipt owned by someone else remains invisible.
  const foreignId = randomUUID();
  db.prepare(
    "INSERT INTO fleet_command_receipts SELECT ?,peer_id,?,fleet_id,grant_id,operation,payload_digest,state,result,created_at,updated_at,command_tag FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
  ).run(foreignOwner, foreignId, OWNER, id);
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        { ...reference, commandId: foreignId },
        localHeaders,
      )
    ).body,
  ).toEqual({ commandId: foreignId, state: "unknown", result: null });
  db.prepare(
    "UPDATE fleet_command_receipts SET result=NULL WHERE owner_id=? AND command_id=?",
  ).run(OWNER, id);
  expect(
    (
      await http(
        host.port,
        origin,
        receiptPath,
        "POST",
        reference,
        localHeaders,
      )
    ).body,
  ).toEqual({ commandId: id, state: "completed", result: null });
  expect(probeCalls).toBe(calls);
  expect(actionCalls - before).toBe(1);
  sourceDb
    .prepare(
      "UPDATE fleet_forwarded_actions SET result=NULL WHERE owner_id=? AND command_id=?",
    )
    .run(owner, id);
  expect((await browser(receiptPath, "POST", reference)).body).toEqual({
    commandId: id,
    state: "completed",
    result: null,
  });
  expect(actionCalls - before).toBe(1);
});

it("refuses unauthorized receipt lookup and retires an absent command without forwarding an action", async () => {
  const before = actionCalls,
    id = randomUUID();
  const reference = {
    peer,
    commandId: id,
    route: "agentCreate",
    payloadDigest: "1".repeat(64),
  };
  expect(
    (
      await http(gateway.port, gatewayOrigin, receiptPath, "POST", reference, {
        origin: gatewayOrigin,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await browser(receiptPath, "POST", reference, {
        "x-loop55-csrf": "wrong",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(receiptPath, "POST", reference, {
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(receiptPath, "POST", reference, {
        "x-http-method-override": "GET",
      })
    ).status,
  ).toBe(403);
  expect(
    (await browser(receiptPath, "POST", { ...reference, owner: foreignOwner }))
      .status,
  ).toBe(400);
  expect(
    (
      await browser(receiptPath, "POST", {
        ...reference,
        peer: source.identity.machineId,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await browser(receiptPath, "POST", {
        ...reference,
        extra: "x".repeat(4096),
      })
    ).status,
  ).toBe(413);
  const original = { cookie, csrf };
  gateway.workspace!.isolated = true;
  try {
    await pair();
    expect((await browser(receiptPath, "POST", reference)).status).toBe(404);
  } finally {
    gateway.workspace!.isolated = false;
    cookie = original.cookie;
    csrf = original.csrf;
  }
  expect((await browser(receiptPath, "POST", reference)).body).toEqual({
    commandId: id,
    state: "refused",
    result: null,
  });
  expect(
    sourceDb
      .prepare(
        "SELECT state FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
      )
      .get(owner, id),
  ).toEqual({ state: "refused" });
  expect(actionCalls).toBe(before);
  expect(localCalls).toBe(0);
});

it("sign-out aborts a receipt lookup before its result is exposed", async () => {
  let release!: () => void;
  holdProbe = new Promise((resolve) => {
    release = resolve;
  });
  const probes = probeCalls,
    before = actionCalls;
  const pending = browser(receiptPath, "POST", {
    peer,
    commandId: randomUUID(),
    route: "agentCreate",
    payloadDigest: "2".repeat(64),
  }).catch((error) => error);
  try {
    await until(() => probeCalls > probes);
    expect((await browser("/api/auth/sign-out", "POST", {})).status).toBe(200);
    release();
    holdProbe = undefined;
    expect(await pending).toBeInstanceOf(Error);
    expect(actionCalls).toBe(before);
  } finally {
    release();
    holdProbe = undefined;
    await pair();
  }
});

it("a concurrent upload lookup cannot consume the first sender's preparation", async () => {
  const bytes = Buffer.from("Concurrent upload receipt"),
    input = uploadManifest(bytes),
    id = randomUUID();
  const probes = probeCalls,
    commits = uploadCommits;
  let release!: () => void;
  holdProbe = new Promise((resolve) => {
    release = resolve;
  });
  const original = browserUpload(input, bytes, id);
  try {
    await until(() => probeCalls > probes);
    const lookup = browserUpload(input, undefined, id, {
      "x-loop55-receipt-only": "1",
    });
    expect((await lookup).headers["x-loop55-command-state"]).toBe("unknown");
    expect(probeCalls).toBe(probes + 1);
    holdProbe = undefined;
    release();
    const [result] = await Promise.all([original, lookup]);
    expect(result.status).toBe(201);
    expect(uploadCommits).toBe(commits + 1);
    expect(
      (
        await browserUpload(input, undefined, id, {
          "x-loop55-receipt-only": "1",
        })
      ).body,
    ).toEqual(result.body);
    expect(uploadCommits).toBe(commits + 1);
  } finally {
    holdProbe = undefined;
    release();
    await original.catch(() => {});
  }
});

it("a failed upload preparation stays uncertain until destination reconciliation", async () => {
  const bytes = Buffer.from("Refused upload"),
    input = uploadManifest(bytes),
    id = randomUUID();
  const commits = uploadCommits,
    calls = fileCalls.length;
  fileFault = "probe";
  try {
    const result = await browserUpload(input, bytes, id);
    expect(result.status).toBe(503);
    expect(result.headers["x-loop55-command-state"]).toBe("unknown");
  } finally {
    fileFault = undefined;
  }
  expect(uploadCommits).toBe(commits);
  expect(
    fileCalls
      .slice(calls)
      .filter((value) => /\/upload\/(prepare|chunk|commit)$/.test(value.path)),
  ).toEqual([]);
  expect(
    (
      await browserUpload(input, undefined, id, {
        "x-loop55-receipt-only": "1",
      })
    ).headers["x-loop55-command-state"],
  ).toBe("refused");
  expect((await browserUpload(input, bytes, randomUUID())).status).toBe(201);
  expect(uploadCommits).toBe(commits + 1);
});

it("recovers a lost upload commit after uploads are withdrawn from the catalog without resending bytes", async () => {
  const bytes = Buffer.from("Source upload fixture"),
    input = uploadManifest(bytes),
    id = randomUUID(),
    before = uploadCommits;
  loseUploadReply = true;
  const unknown = await browserUpload(input, bytes, id);
  loseUploadReply = false;
  expect(unknown.status).toBe(503);
  expect(unknown.body.executionOutcome).toBe("unknown");
  expect(uploadCommits).toBe(before + 1);
  expect(
    sourceDb
      .prepare(
        "SELECT route,payload_digest,state FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
      )
      .get(owner, id),
  ).toMatchObject({
    route: "uploadCreate",
    payload_digest: fleetPayloadDigest(input),
    state: "unknown",
  });
  const calls = fileCalls.length;
  fileFault = "upload-withdrawn";
  let recovered: Reply;
  try {
    recovered = await browserUpload(input, undefined, id, {
      "x-loop55-receipt-only": "1",
    });
  } finally {
    fileFault = undefined;
  }
  expect(recovered.status).toBe(201);
  expect(recovered.body).toMatchObject({
    name: "résumé.txt",
    mime: "text/plain",
    size: bytes.length,
  });
  expect(recovered.headers["x-loop55-command-state"]).toBe("completed");
  const object = db
    .prepare("SELECT bytes,owner_id FROM objects WHERE id=?")
    .get(recovered.body.objectId) as { bytes: Buffer; owner_id: string };
  expect(object.owner_id).toBe(OWNER);
  expect(object.bytes.equals(bytes)).toBe(true);
  expect(
    fileCalls
      .slice(calls)
      .filter((value) => /\/upload\/(prepare|chunk|commit)$/.test(value.path)),
  ).toEqual([]);
  expect(uploadCommits).toBe(before + 1);
  expect(localCalls).toBe(0);
});

it("checks an upload receipt without its body and shares command identity with JSON actions", async () => {
  const bytes = Buffer.from("Bodyless upload receipt"),
    input = uploadManifest(bytes),
    id = randomUUID();
  const result = await browserUpload(input, bytes, id);
  expect(result.status).toBe(201);
  const calls = fileCalls.length;
  const receipt = await browser("/api/fleet/commands/receipt", "POST", {
    peer,
    commandId: id,
    route: "uploadCreate",
    payloadDigest: fleetPayloadDigest(input),
  });
  expect(receipt.status).toBe(200);
  expect(receipt.body).toMatchObject({
    commandId: id,
    state: "completed",
    result: result.body,
  });
  expect(fileCalls.length).toBe(calls);
  const before = actionCalls;
  expect(
    (
      await browser(prefix + "/agents", "POST", createBody(), {
        "x-loop55-command-id": id,
      })
    ).status,
  ).toBe(409);
  expect(actionCalls).toBe(before);
  expect(
    (
      await browserUpload(
        uploadManifest(Buffer.from("changed")),
        Buffer.from("changed"),
        id,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await browserUpload(input, bytes, randomUUID(), {
        origin: "https://foreign.example",
      })
    ).status,
  ).toBe(403);
  expect((await browserUpload(input, bytes, "not-a-command")).status).toBe(400);
});

it("does not commit a malformed signed upload acknowledgement or replay the uncertain upload", async () => {
  const bytes = Buffer.from("Uncertain upload acknowledgement"),
    input = uploadManifest(bytes),
    id = randomUUID(),
    before = uploadCommits;
  corruptUploadChunk = true;
  try {
    const response = await browserUpload(input, bytes, id);
    expect(response.status).toBe(503);
    expect(response.body.executionOutcome).toBe("unknown");
  } finally {
    corruptUploadChunk = false;
  }
  expect(uploadCommits).toBe(before);
  const calls = fileCalls.length;
  const missing = await browserUpload(input, undefined, id, {
    "x-loop55-receipt-only": "1",
  });
  expect(missing.status).toBe(409);
  expect(missing.body.executionOutcome).toBe("refused");
  expect(
    fileCalls
      .slice(calls)
      .filter((value) => /\/upload\/(prepare|chunk|commit)$/.test(value.path)),
  ).toEqual([]);
  expect(uploadCommits).toBe(before);
});

it("sign-out prevents a staged commit and the destination later retires its ID", async () => {
  const bytes = Buffer.from("held upload"),
    input = uploadManifest(bytes),
    id = randomUUID(),
    before = uploadCommits;
  let release!: () => void;
  holdUploadChunk = new Promise((resolve) => {
    release = resolve;
  });
  uploadChunkStarted = false;
  const pending = browserUpload(input, bytes, id).catch((error) => error);
  try {
    await until(() => uploadChunkStarted);
    expect((await browser("/api/auth/sign-out", "POST", {})).status).toBe(200);
    expect(await pending).toBeInstanceOf(Error);
    expect(uploadCommits).toBe(before);
  } finally {
    holdUploadChunk = undefined;
    release();
    await pair();
  }
  await expect
    .poll(
      async () =>
        (
          await browser("/api/fleet/commands/receipt", "POST", {
            peer,
            commandId: id,
            route: "uploadCreate",
            payloadDigest: fleetPayloadDigest(input),
          })
        ).body,
    )
    .toEqual({ commandId: id, state: "refused", result: null });
  expect(uploadCommits).toBe(before);
  expect((await browserUpload(input, bytes, randomUUID())).status).toBe(201);
  expect(uploadCommits).toBe(before + 1);
});

it.each(["probe", "upload-withdrawn", "capacity"] as const)(
  "a fresh upload forwarding journal preserves a completed receipt during %s",
  async (failure) => {
    const bytes = Buffer.from("Upload already committed"),
      input = uploadManifest(bytes),
      id = randomUUID();
    const first = await browserUpload(input, bytes, id);
    expect(first.status).toBe(201);
    const commits = uploadCommits;
    const journal = new Database(":memory:");
    applyMigrations(journal);
    const other = new FleetPeerUploads(
      journal,
      source,
      leases,
      owner,
      new FleetWorkspaceUploadHttpTransport(fetcher),
    );
    const controllers: AbortController[] = [];
    const occupied: Promise<unknown>[] = [];
    let release: (() => void) | undefined;
    try {
      if (failure === "capacity") {
        const probes = probeCalls;
        holdProbe = new Promise<void>((resolve) => {
          release = resolve;
        });
        for (let i = 0; i < 2; i++) {
          const controller = new AbortController();
          controllers.push(controller);
          occupied.push(
            other.upload(
              peer,
              randomUUID(),
              input,
              bytes,
              () => {},
              controller.signal,
            ),
          );
        }
        await until(() => probeCalls === probes + 2);
      } else fileFault = failure;
      expect(await other.upload(peer, id, input, bytes, () => {})).toEqual({
        commandId: id,
        state: "unknown",
        result: null,
      });
      fileFault = undefined;
      for (const controller of controllers) controller.abort();
      await Promise.all(occupied);
      holdProbe = undefined;
      release?.();
      expect(
        await other.lookup(peer, id, fleetPayloadDigest(input), () => {}),
      ).toEqual({
        commandId: id,
        state: "completed",
        result: first.body,
      });
      expect(uploadCommits).toBe(commits);
    } finally {
      fileFault = undefined;
      holdProbe = undefined;
      for (const controller of controllers) controller.abort();
      release?.();
      await Promise.allSettled(occupied);
      other.close();
      journal.close();
    }
  },
);

it("keeps a completed command uncertain when its destination is removed before retry", async () => {
  const id = randomUUID(),
    body = createBody(),
    before = actionCalls;
  loseReply = true;
  try {
    expect(
      (
        await browser(prefix + "/agents", "POST", body, {
          "x-loop55-command-id": id,
        })
      ).body.executionOutcome,
    ).toBe("unknown");
  } finally {
    loseReply = false;
  }
  expect(
    db
      .prepare("SELECT state FROM fleet_command_receipts WHERE command_id=?")
      .get(id),
  ).toEqual({ state: "completed" });
  // Keep this authority transition isolated from the file-stream removal case.
  const isolatedDb = new Database(sourceDb.serialize());
  const isolated = new FleetAuthority(isolatedDb, secrets);
  const isolatedActions = new FleetPeerActions(
    isolatedDb,
    isolated,
    leases,
    owner,
    new FleetWorkspaceActionHttpTransport(fetcher),
  );
  const originalSources = gateway.workspace!.sources;
  try {
    gateway.workspace!.sources = new AgentSources([
      fleetAgentSource(isolated, owner, peerReads, isolatedActions),
    ]);
    const directory = isolated.directory(owner)!;
    isolated.revise(owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(directory.document),
      members: directory.document.members.filter(
        (item) => item.machineId !== peer,
      ),
    });
    const retry = await browser(prefix + "/agents", "POST", body, {
      "x-loop55-command-id": id,
    });
    expect(retry.status).toBe(403);
    expect(retry.body.executionOutcome).toBe("unknown");
    expect(retry.headers["x-loop55-command-state"]).toBeUndefined();
    expect(actionCalls).toBe(before + 1);
    expect(
      db
        .prepare("SELECT count(*) n FROM agents WHERE owner_id=? AND name=?")
        .get(OWNER, body.name),
    ).toEqual({ n: 1 });
  } finally {
    gateway.workspace!.sources = originalSources;
    isolatedActions.close();
    isolatedDb.close();
  }
});

it("a newly known removal stops an open file before its remaining chunks", async () => {
  const file = object(randomBytes(FLEET_FILE_CHUNK_BYTES + 17));
  let release!: () => void,
    writes = 0;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = peerFiles
    .download(peer, fileSelection(file.objectId), {
      start: () => {},
      write: async () => {
        writes++;
        await pause;
      },
    })
    .catch((error) => error);
  try {
    await until(() => writes === 1);
    const current = source.directory(owner)!;
    source.revise(owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(current.document),
      members: current.document.members.filter(
        (value) => value.machineId !== peer,
      ),
    });
    expect(await pending).toBeInstanceOf(Error);
    expect(writes).toBe(1);
    const before = fileCalls.length;
    expect((await download("/objects/" + file.objectId)).status).toBe(403);
    expect(fileCalls.length).toBe(before);
  } finally {
    release();
  }
});
