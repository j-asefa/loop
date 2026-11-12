import { createHost } from "./helpers/gateway.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  truncateSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { FleetWorkspaceFiles } from "../src/server/fleet-workspace-files.js";
import { FleetWorkspaceRead } from "../src/server/fleet-workspace-read.js";
import { applyMigrations } from "../src/server/migrations.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import { verifyFleetProof } from "../src/server/fleet-proof.js";
import {
  fleetWorkspaceFileApi,
  FLEET_FILE_CHUNK_BYTES,
} from "../src/shared/fleet-workspace-file-api.js";
import { fleetWorkspaceApi } from "../src/shared/fleet-workspace-api.js";
import { until } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-files-"));
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { app } = await import("../src/server/index.js");
const { db } = await import("../src/server/db.js");
const { OWNER, nativeSessions } =
  await import("../src/server/native-sessions.js");
const { closeExecution } = await import("../src/server/execution-client.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
const { uploadFile } = await import("../src/server/uploads.js");
const { saveArtifact } = await import("../src/server/artifacts.js");
const { createAgent } = await import("../src/server/domain.js");
const { submit } = await import("../src/server/agent-runtime.js");
const { recordTrace } = await import("../src/server/traces.js");
const secrets = await import("../src/server/secrets.js");
function peer() {
  const database = new Database(":memory:");
  applyMigrations(database);
  const authority = new FleetAuthority(database, secrets);
  return {
    db: database,
    authority,
    owner: randomUUID(),
    credentials: new FleetCredentials(database, authority, secrets),
  };
}
const source = peer(),
  other = peer();
const destination = new FleetAuthority(db, secrets),
  credentials = new FleetCredentials(db, destination, secrets);
const origin = "https://files-destination.example";
const initial = source.authority.create(source.owner, {
  mutationId: randomUUID(),
  name: "Source",
  origin: "https://files-source.example",
  scope: ["read", "files"],
});
const directory = source.authority.revise(source.owner, {
  mutationId: randomUUID(),
  expected: directoryDigest(initial.document),
  members: [
    ...initial.document.members,
    {
      ...destination.identity,
      name: "Destination",
      origin,
      grantId: randomUUID(),
    },
    {
      ...other.authority.identity,
      name: "Other",
      origin: "https://files-other.example",
      grantId: randomUUID(),
    },
  ],
});
for (const [authority, owner] of [
  [destination, OWNER],
  [other.authority, other.owner],
] as const)
  authority.approve(owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    scope: ["read", "files"],
    controller: source.authority.identity,
    directory,
    grantId: directory.document.members.find(
      (member) => member.machineId === authority.identity.machineId,
    )!.grantId,
  });
function token(client = source, operation: "read" | "files" = "files") {
  const proof = client.credentials.prove(
    client.owner,
    credentials.challenge({
      fleetId: directory.document.fleetId,
      grantId: directory.document.members[1].grantId,
      destination: destination.identity.machineId,
      peer: client.authority.identity.machineId,
      directory: directoryDigest(directory.document),
      operation,
    }),
  );
  return client.credentials.accept(
    client.owner,
    proof,
    credentials.issue(proof),
  ).token;
}
const fileToken = token(),
  otherToken = token(other),
  readToken = token(source, "read");
let clock = 1000,
  hold: Promise<void> | undefined,
  began: (() => void) | undefined;
const bridge = new FleetWorkspaceApp((req, res) => {
  if (!hold) return app(req, res);
  began?.();
  void hold.then(() => app(req, res));
}, OWNER);
const files = new FleetWorkspaceFiles(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
  () => clock,
);
const reads = new FleetWorkspaceRead(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
  { files: true },
);
const pairing = new FleetPairing(db, destination, OWNER, root);
const host = createHost(root, pairing);
let disconnected = false;
const peerHttp = createFleetPeerHttp(
  new FleetEnrollmentDestination(
    db,
    destination,
    pairing,
    OWNER,
    secrets,
    () => origin,
  ),
  () => origin,
  { workspaceFiles: files, workspaceRead: reads, credentials },
);
host.workspace = {
  http: app,
  peerHttp: (req, res) => {
    res.once("close", () => {
      if (!res.writableFinished) disconnected = true;
    });
    peerHttp(req, res);
  },
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
type Reply = { status: number; headers: Record<string, unknown>; body: any };
function call(
  route: keyof typeof fleetWorkspaceFileApi,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Reply> {
  return wire(
    "/api" + fleetWorkspaceFileApi[route].path,
    body,
    headers,
    signal,
  );
}
function wire(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        method: "POST",
        signal,
        headers: {
          host: new URL(origin).host,
          "content-type": "application/json",
          "x-loop-fleet-version": "1",
          ...headers,
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
    req.end(JSON.stringify(body));
  });
}
const admission = (credential = fileToken) => ({
  version: 1,
  requestId: randomUUID(),
  credential,
});
const bytes = Buffer.alloc(FLEET_FILE_CHUNK_BYTES + 17, 0x61);
let objectId: string,
  foreignId: string,
  emptyId: string,
  publishedId: string,
  publishedPath: string;
const openRequest = (id = objectId) => ({
  ...admission(),
  selection: { route: "objectFile", params: { id }, query: {} },
});
const query = (id: string, offset = 0, credential = fileToken) => ({
  ...admission(credential),
  transferId: id,
  offset,
});
const release = (id: string) =>
  call("close", { ...admission(), transferId: id });
beforeAll(async () => {
  objectId = uploadFile(OWNER, {
    originalname: "fixture.bin",
    mimetype: "application/octet-stream",
    buffer: bytes,
  }).objectId;
  foreignId = uploadFile("foreign-owner", {
    originalname: "foreign",
    mimetype: "text/plain",
    buffer: Buffer.from("private foreign content"),
  }).objectId;
  emptyId = uploadFile(OWNER, {
    originalname: "empty",
    mimetype: "text/plain",
    buffer: Buffer.alloc(0),
  }).objectId;
  publishedId = saveArtifact(OWNER, {
    title: "Published fixture",
    kind: "file",
    content: "fixture",
    metadata: { name: "published.txt", mime: "text/plain" },
    role: "file",
  });
  const key = `objects/${"a".repeat(64)}/${randomUUID()}/${"b".repeat(64)}`;
  publishedPath = join(root, key);
  mkdirSync(join(publishedPath, ".."), { recursive: true });
  writeFileSync(publishedPath, bytes);
  db.prepare("INSERT INTO artifact_objects VALUES(?,?,?,?,?,?,?,?)").run(
    publishedId,
    OWNER,
    randomUUID(),
    randomUUID(),
    key,
    "text/plain",
    bytes.length,
    createHash("sha256").update(bytes).digest("base64"),
  );
  await host.listen();
  host.setOrigin(origin);
});
afterAll(async () => {
  files.close();
  reads.close();
  await host.close();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  source.db.close();
  other.db.close();
  rmSync(root, { recursive: true, force: true });
});

it("signs bounded bytes from the real object handler and pins their identity across chunks", async () => {
  const input = openRequest(),
    opened = await call("open", input);
  expect(opened.status).toBe(200);
  const value = opened.body.response,
    id = value.transferId;
  expect(value.file).toMatchObject({
    size: bytes.length,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    mediaType: "application/octet-stream",
  });
  expect(value.requestDigest).toBe(
    fleetPayloadDigest({
      requestId: input.requestId,
      selection: input.selection,
    }),
  );
  expect(
    verifyFleetProof(
      destination.identity,
      "workspace-file-open",
      value,
      opened.body.signature,
    ),
  ).toBe(true);
  expect(opened.headers).not.toHaveProperty("set-cookie");
  expect(JSON.stringify(opened.body)).not.toContain(fileToken);
  const chunks: Buffer[] = [];
  for (let offset = 0; ;) {
    const input = query(id, offset),
      reply = await call("chunk", input),
      result = reply.body.response;
    expect(reply.status).toBe(200);
    expect(result.offset).toBe(offset);
    expect(result.requestDigest).toBe(
      fleetPayloadDigest({
        requestId: input.requestId,
        transferId: id,
        offset,
      }),
    );
    expect(
      verifyFleetProof(
        destination.identity,
        "workspace-file-chunk",
        result,
        reply.body.signature,
      ),
    ).toBe(true);
    expect(
      verifyFleetProof(
        destination.identity,
        "workspace-file-chunk",
        { ...result, requestId: randomUUID() },
        reply.body.signature,
      ),
    ).toBe(false);
    const chunk = Buffer.from(result.base64, "base64");
    expect(chunk.length).toBeLessThanOrEqual(FLEET_FILE_CHUNK_BYTES);
    chunks.push(chunk);
    if (result.nextOffset === null) break;
    offset = result.nextOffset;
  }
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect((await call("chunk", query(id, bytes.length + 1))).status).toBe(416);
  expect((await release(id)).status).toBe(200);
  expect((await call("chunk", query(id))).status).toBe(404);
  expect((await release(id)).status).toBe(200);
});

it("requires files consent and ownership, and does not share a transfer between admitted peers", async () => {
  expect(
    (await call("open", { ...openRequest(), credential: readToken })).status,
  ).toBe(403);
  expect((await call("open", openRequest(foreignId))).status).toBe(404);
  expect(
    (await call("open", { ...openRequest(), owner: "foreign-owner" })).status,
  ).toBe(400);
  expect(
    (await call("open", openRequest(), { cookie: "fixture-cookie" })).status,
  ).toBe(403);
  const id = (await call("open", openRequest())).body.response.transferId;
  expect((await call("chunk", query(id, 0, otherToken))).status).toBe(404);
  expect(
    (await call("close", { ...admission(otherToken), transferId: id })).status,
  ).toBe(404);
  expect((await call("chunk", query(id))).status).toBe(200);
  await release(id);
  const catalog = await wire(
    "/api" + fleetWorkspaceApi.catalog.path,
    admission(),
  );
  expect(catalog.status).toBe(200);
  expect(catalog.body.catalog.files).toBe(true);
  const read = await wire("/api" + fleetWorkspaceApi.read.path, {
    ...admission(),
    input: { route: "bootstrap", params: {}, query: {} },
  });
  expect(read.status).toBe(403);
});

it("bounds live snapshots, expires idle downloads and handles empty files", async () => {
  const first = (await call("open", openRequest())).body.response.transferId;
  const second = (await call("open", openRequest(emptyId))).body.response
    .transferId;
  expect((await call("open", openRequest())).status).toBe(503);
  expect((await call("chunk", query(second))).body.response).toMatchObject({
    offset: 0,
    nextOffset: null,
    base64: "",
  });
  clock += 30_001;
  expect((await call("chunk", query(first))).status).toBe(404);
  expect((await call("chunk", query(second))).status).toBe(404);
  const again = (await call("open", openRequest())).body.response.transferId;
  await release(again);
});

it("exports the owning run's public traces and rejects another owner's run and invalid selections", async () => {
  const connection = randomUUID();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,'{}',0)",
  ).run(
    connection,
    OWNER,
    secrets.seal("fixture", OWNER),
    JSON.stringify([{ id: "fixture" }]),
  );
  const agent = createAgent(OWNER, {
    name: "file-traces",
    connectionId: connection,
    model: "fixture",
  });
  const run = submit(OWNER, {
    agentId: agent.id,
    input: "Export fixture",
    idempotencyKey: randomUUID(),
  });
  recordTrace(run, "public", {
    kind: "message",
    title: "Update",
    content: "Public fixture",
  });
  const input = {
    ...admission(),
    selection: {
      route: "agentTracesExport",
      params: { id: agent.id },
      query: { run: run.id },
    },
  };
  const opened = await call("open", input);
  expect(opened.status).toBe(200);
  const value = opened.body.response;
  expect(value.file).toMatchObject({
    mediaType: "application/json; charset=utf-8",
  });
  const chunk = await call("chunk", query(value.transferId));
  const text = Buffer.from(chunk.body.response.base64, "base64").toString();
  expect(JSON.parse(text)).toMatchObject({
    agent: { id: agent.id },
    run: { id: run.id },
  });
  expect(text).toContain("Public fixture");
  const approvedScope = (
    db
      .prepare("SELECT scope FROM fleet_binding WHERE owner_id=?")
      .get(OWNER) as {
      scope: string;
    }
  ).scope;
  const setScope = (scope: string) =>
    db
      .transaction(() => {
        db.prepare("UPDATE fleet_binding SET scope=? WHERE owner_id=?").run(
          scope,
          OWNER,
        );
        db.prepare("UPDATE fleet_peer_grants SET scope=? WHERE owner_id=?").run(
          scope,
          OWNER,
        );
      })
      .immediate();
  // Seed a files-only consent state at the production admission boundary.
  // Its files credential remains valid, but cannot grant conversation reads.
  setScope(JSON.stringify(["files"]));
  try {
    const ordinary = await call("open", openRequest());
    expect(ordinary.status).toBe(200);
    await release(ordinary.body.response.transferId);
    const exportWithoutRead = await call("open", input);
    if (exportWithoutRead.status === 200)
      await release(exportWithoutRead.body.response.transferId);
    expect(exportWithoutRead.status).toBe(403);
    expect((await call("chunk", query(value.transferId))).status).toBe(403);
  } finally {
    setScope(approvedScope);
  }
  await release(value.transferId);
  expect(
    (
      await call("open", {
        ...input,
        selection: { ...input.selection, query: {} },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("open", {
        ...openRequest(),
        selection: { ...openRequest().selection, query: { run: run.id } },
      })
    ).status,
  ).toBe(400);
  db.prepare("UPDATE runs SET owner_id='foreign-owner' WHERE id=?").run(run.id);
  expect((await call("open", input)).status).toBe(404);
  db.prepare("UPDATE runs SET owner_id=?,state='cancelled' WHERE id=?").run(
    OWNER,
    run.id,
  );
});

it("expires a continuously used transfer at its total lifetime", async () => {
  const id = (await call("open", openRequest())).body.response.transferId;
  for (let elapsed = 0; elapsed < 100_000; elapsed += 20_000) {
    clock += 20_000;
    expect((await call("chunk", query(id))).status).toBe(200);
  }
  clock += 20_000;
  expect((await call("chunk", query(id))).status).toBe(404);
});

it("uses the owning HTML preview and rejects corrupted, oversized-on-disk and symlinked publications", async () => {
  const html = uploadFile(OWNER, {
    originalname: "preview.html",
    mimetype: "text/html",
    buffer: Buffer.from("<p>Untrusted preview</p>"),
  });
  const preview = await call("open", {
    ...admission(),
    selection: {
      route: "objectFile",
      params: { id: html.objectId },
      query: { preview: "html" },
    },
  });
  expect(preview.status).toBe(200);
  expect(preview.body.response.file.mediaType).toBe("text/html; charset=utf-8");
  await release(preview.body.response.transferId);
  const input = {
    ...admission(),
    selection: {
      route: "artifactFile",
      params: { id: publishedId },
      query: {},
    },
  };
  const original = await call("open", input);
  expect(original.status).toBe(200);
  await release(original.body.response.transferId);
  writeFileSync(publishedPath, Buffer.alloc(bytes.length, 0x62));
  expect((await call("open", input)).status).toBe(409);
  truncateSync(publishedPath, 100 * 1024 * 1024);
  expect((await call("open", input)).status).toBe(409);
  unlinkSync(publishedPath);
  const outside = join(root, "outside-fixture");
  writeFileSync(outside, bytes);
  symlinkSync(outside, publishedPath);
  expect((await call("open", input)).status).toBe(409);
  unlinkSync(publishedPath);
  writeFileSync(publishedPath, bytes);
});

it("rechecks removal before chunks and does not retain a disconnected open request", async () => {
  const disposable = uploadFile(OWNER, {
    originalname: "removed",
    mimetype: "text/plain",
    buffer: Buffer.from("deleted fixture"),
  });
  const id = (await call("open", openRequest(disposable.objectId))).body
    .response.transferId;
  db.prepare("DELETE FROM objects WHERE id=? AND owner_id=?").run(
    disposable.objectId,
    OWNER,
  );
  expect((await call("chunk", query(id))).status).toBe(404);
  let finish!: () => void,
    started = false;
  hold = new Promise((resolve) => {
    finish = resolve;
  });
  began = () => {
    started = true;
  };
  const caller = new AbortController(),
    pending = call("open", openRequest(), {}, caller.signal).catch(
      (error) => error,
    );
  await until(() => started);
  caller.abort();
  expect(await pending).toBeInstanceOf(Error);
  await until(() => disconnected);
  hold = undefined;
  began = undefined;
  await until(() =>
    files
      .open(openRequest())
      .then((value) => {
        files.release({
          ...admission(),
          transferId: value.response.transferId,
        });
        return true;
      })
      .catch(() => false),
  );
  const first = (await call("open", openRequest())).body.response.transferId;
  const second = await call("open", openRequest());
  finish();
  expect(second.status).toBe(200);
  await release(first);
  await release(second.body.response.transferId);
});

it("fences an open transfer after destination removal and closes its service", async () => {
  const id = (await call("open", openRequest())).body.response.transferId;
  const removed = source.authority.revise(source.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(directory.document),
    members: directory.document.members.filter(
      (member) => member.machineId !== destination.identity.machineId,
    ),
  });
  destination.accept(OWNER, removed);
  expect((await call("chunk", query(id))).status).toBe(403);
  expect((await call("open", openRequest())).status).toBe(403);
  files.close();
  expect((await call("open", openRequest())).status).toBe(403);
});
