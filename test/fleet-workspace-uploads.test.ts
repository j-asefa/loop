import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Host } from "../src/host.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { FleetWorkspaceUploads } from "../src/server/fleet-workspace-uploads.js";
import { FleetWorkspaceRead } from "../src/server/fleet-workspace-read.js";
import { FleetCommands } from "../src/server/fleet-commands.js";
import {
  currentFleetAction,
  withFleetAction,
} from "../src/server/fleet-action-context.js";
import { applyMigrations } from "../src/server/migrations.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import { verifyFleetProof } from "../src/server/fleet-proof.js";
import {
  FleetUploadInput,
  fleetUploadProofInput,
  fleetWorkspaceUploadApi,
} from "../src/shared/fleet-workspace-upload-api.js";
import {
  FLEET_FILE_BYTES,
  FLEET_FILE_CHUNK_BYTES,
} from "../src/shared/fleet-workspace-file-api.js";
import { fleetWorkspaceApi } from "../src/shared/fleet-workspace-api.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-uploads-"));
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
const secrets = await import("../src/server/secrets.js");
function peer() {
  const db = new Database(":memory:");
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const authority = new FleetAuthority(db, secrets);
  return {
    db,
    authority,
    owner: randomUUID(),
    credentials: new FleetCredentials(db, authority, secrets),
  };
}
const source = peer(),
  other = peer();
const destination = new FleetAuthority(db, secrets),
  credentials = new FleetCredentials(db, destination, secrets);
const origin = "https://uploads-destination.example";
const initial = source.authority.create(source.owner, {
  mutationId: randomUUID(),
  name: "Source",
  origin: "https://uploads-source.example",
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
      origin: "https://uploads-other.example",
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
  applied = 0,
  throwAfterWrite = false,
  loseReply = false;
const producer: typeof uploadFile = (owner, file, options) => {
  const context = currentFleetAction()!;
  expect(context.owner).toBe(owner);
  expect(context.grant.operation).toBe("files");
  expect(
    db
      .prepare(
        "SELECT state,operation FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
      )
      .get(owner, context.commandId),
  ).toMatchObject({ state: "started", operation: "files" });
  applied++;
  const result = uploadFile(owner, file, options);
  if (throwAfterWrite)
    throw new Error("fixture private producer failure after write");
  return result;
};
const service = () =>
  new FleetWorkspaceUploads(
    db,
    destination,
    credentials,
    OWNER,
    secrets,
    producer,
    () => clock,
  );
let uploads = service();
const bridge = new FleetWorkspaceApp(app, OWNER);
const reads = new FleetWorkspaceRead(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
  { files: true, uploads: true },
);
const pairing = new FleetPairing(db, destination, OWNER, root);
const host = new Host(
  root,
  {
    harness: "codex",
    version: "fixture",
    project: root,
    billing: { mode: "existing", description: "Isolated fixture" },
    capabilities: {
      approvals: true,
      questions: true,
      resume: true,
      liveAttach: false,
      terminal: false,
    },
  },
  pairing,
);
const mount = () =>
  createFleetPeerHttp(
    new FleetEnrollmentDestination(
      db,
      destination,
      pairing,
      OWNER,
      secrets,
      () => origin,
    ),
    () => origin,
    { workspaceUploads: uploads, workspaceRead: reads, credentials },
  );
let peerHttp = mount();
host.workspace = {
  http: app,
  peerHttp: (req, res) => {
    if (loseReply && req.url === "/api" + fleetWorkspaceUploadApi.commit.path) {
      const end = res.end;
      res.end = function (...args: Parameters<typeof end>) {
        res.destroy();
        return res;
      } as typeof end;
    }
    peerHttp(req, res);
  },
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
type Reply = { status: number; headers: Record<string, unknown>; body: any };
function wire(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        method: "POST",
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
type Route = keyof typeof fleetWorkspaceUploadApi;
const purpose = {
  prepare: "workspace-upload-prepare",
  chunk: "workspace-upload-chunk",
  close: "workspace-upload-close",
  commit: "workspace-upload-receipt",
  receipt: "workspace-upload-receipt",
} as const;
async function call<
  T extends { credential: string; commandId: string; requestId: string },
>(route: Route, body: T, headers: Record<string, string> = {}) {
  const reply = await wire(
    "/api" + fleetWorkspaceUploadApi[route].path,
    body,
    headers,
  );
  if (reply.status === 200) {
    const value = fleetWorkspaceUploadApi[route].response.parse(reply.body);
    expect(
      verifyFleetProof(
        destination.identity,
        purpose[route],
        value.response,
        value.signature,
      ),
    ).toBe(true);
    expect(value.response).toMatchObject({
      requestId: body.requestId,
      commandId: body.commandId,
      machineId: destination.identity.machineId,
      requestDigest: fleetPayloadDigest(fleetUploadProofInput(body)),
    });
    expect(reply.headers).not.toHaveProperty("set-cookie");
    expect(JSON.stringify(value)).not.toContain(body.credential);
  }
  return reply;
}
const admission = (commandId: string, credential = fileToken) => ({
  version: 1 as const,
  requestId: randomUUID(),
  commandId,
  credential,
});
const manifest = (
  bytes: Buffer,
  options: FleetUploadInput["body"]["options"] = {},
) =>
  FleetUploadInput.parse({
    route: "uploadCreate",
    params: {},
    body: {
      options,
      file: {
        name: "fixture.bin",
        mime: "application/octet-stream",
        size: bytes.length,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  });
type Prepared = {
  commandId: string;
  transferId: string;
  input: FleetUploadInput;
  payloadDigest: string;
};
async function prepare(
  input: FleetUploadInput,
  commandId = randomUUID(),
): Promise<Prepared> {
  const reply = await call("prepare", { ...admission(commandId), input });
  expect(reply.status).toBe(200);
  expect(reply.body.response).toMatchObject({
    receipt: null,
    nextOffset: 0,
    chunkBytes: FLEET_FILE_CHUNK_BYTES,
  });
  return {
    commandId,
    input,
    transferId: reply.body.response.transferId,
    payloadDigest: fleetPayloadDigest(input),
  };
}
const transfer = (item: Prepared, credential = fileToken) => ({
  ...admission(item.commandId, credential),
  transferId: item.transferId,
  payloadDigest: item.payloadDigest,
});
const commit = (item: Prepared) => ({
  ...admission(item.commandId),
  transferId: item.transferId,
  input: item.input,
});
async function fill(item: Prepared, bytes: Buffer) {
  for (
    let offset = 0;
    offset < bytes.length;
    offset += FLEET_FILE_CHUNK_BYTES
  ) {
    const end = Math.min(offset + FLEET_FILE_CHUNK_BYTES, bytes.length);
    const reply = await call("chunk", {
      ...transfer(item),
      offset,
      base64: bytes.subarray(offset, end).toString("base64"),
    });
    expect(reply.status).toBe(200);
    expect(reply.body.response.nextOffset).toBe(end);
  }
}
const count = () =>
  (
    db
      .prepare("SELECT count(*) n FROM objects WHERE owner_id=?")
      .get(OWNER) as { n: number }
  ).n;
beforeAll(async () => {
  await host.listen();
  host.setOrigin(origin);
});
afterAll(async () => {
  uploads.close();
  reads.close();
  await host.close();
  await closeExecution();
  await nativeSessions.close();
  source.db.close();
  other.db.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it("stages bounded bytes without workspace effects, then persists one command before the owning upload", async () => {
  const bytes = randomBytes(FLEET_FILE_CHUNK_BYTES + 17),
    before = count(),
    calls = applied;
  const item = await prepare(manifest(bytes));
  expect(count()).toBe(before);
  expect(
    (
      await call("receipt", {
        ...admission(item.commandId),
        payloadDigest: item.payloadDigest,
      })
    ).body.response.receipt,
  ).toBeNull();
  await fill(item, bytes);
  expect(count()).toBe(before);
  const response = await call("commit", commit(item));
  expect(response.status).toBe(200);
  const receipt = response.body.response.receipt;
  expect(receipt).toMatchObject({
    commandId: item.commandId,
    state: "completed",
    result: { size: bytes.length, name: "fixture.bin" },
  });
  const object = db
    .prepare("SELECT owner_id,bytes FROM objects WHERE id=?")
    .get(receipt.result.objectId) as { owner_id: string; bytes: Buffer };
  expect(object.owner_id).toBe(OWNER);
  expect(object.bytes.equals(bytes)).toBe(true);
  expect(count()).toBe(before + 1);
  expect(applied).toBe(calls + 1);
  expect((await call("commit", commit(item))).body.response.receipt).toEqual(
    receipt,
  );
  expect(
    (await call("prepare", { ...admission(item.commandId), input: item.input }))
      .body.response,
  ).toMatchObject({ transferId: null, receipt });
  expect(applied).toBe(calls + 1);
  expect(uploads.localReceipt(item.commandId, item.payloadDigest)).toEqual(
    receipt,
  );
  expect(() =>
    new FleetCommands(db, destination).localReceipt(
      OWNER,
      item.commandId,
      item.payloadDigest,
      "uploadCreate",
    ),
  ).toThrow();
});

it("requires files consent, the owning references and the original command/digest for every transfer", async () => {
  const bytes = Buffer.from("scope fixture"),
    input = manifest(bytes),
    id = randomUUID();
  expect(
    (await call("prepare", { ...admission(id, readToken), input })).status,
  ).toBe(403);
  expect(
    (
      await call(
        "prepare",
        { ...admission(id), input },
        { cookie: "untrusted" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call("prepare", {
        ...admission(id),
        input: { ...input, owner: OWNER },
      })
    ).status,
  ).toBe(400);
  const foreignFolder = randomUUID();
  db.prepare(
    "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,? ,NULL,'folder','Foreign',0)",
  ).run(foreignFolder, "foreign-owner");
  expect(
    (
      await call("prepare", {
        ...admission(id),
        input: manifest(bytes, { folderId: foreignFolder }),
      })
    ).status,
  ).toBe(404);
  const item = await prepare(input, id);
  try {
    expect(
      (
        await call("chunk", {
          ...transfer(item, otherToken),
          offset: 0,
          base64: bytes.toString("base64"),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("chunk", {
          ...transfer(item),
          commandId: randomUUID(),
          offset: 0,
          base64: bytes.toString("base64"),
        })
      ).status,
    ).toBe(409);
    expect((await call("close", transfer(item, otherToken))).status).toBe(409);
    expect(
      (
        await call("prepare", {
          ...admission(id),
          input: manifest(Buffer.from("changed")),
        })
      ).status,
    ).toBe(409);
    await fill(item, bytes);
    expect((await call("commit", commit(item))).status).toBe(200);
    expect(
      (
        await call("commit", {
          ...commit(item),
          input: manifest(Buffer.from("changed")),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("receipt", {
          ...admission(id),
          payloadDigest: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
  } finally {
    await call("close", transfer(item));
  }
  const catalog = await wire("/api" + fleetWorkspaceApi.catalog.path, {
    version: 1,
    requestId: randomUUID(),
    credential: fileToken,
  });
  expect(catalog.body.catalog).toMatchObject({
    files: true,
    actions: ["uploadCreate"],
  });
});

it("rejects noncanonical, out-of-order, oversized and corrupt data before creating an object", async () => {
  const before = count(),
    bytes = Buffer.from("abc"),
    input = manifest(bytes),
    id = randomUUID();
  expect(
    (
      await call("prepare", {
        ...admission(id),
        input: {
          ...input,
          body: {
            ...input.body,
            file: { ...input.body.file, size: FLEET_FILE_BYTES + 1 },
          },
        },
      })
    ).status,
  ).toBe(400);
  const item = await prepare(input);
  try {
    expect(
      (await call("chunk", { ...transfer(item), offset: 1, base64: "YQ==" }))
        .status,
    ).toBe(409);
    expect(
      (await call("chunk", { ...transfer(item), offset: 0, base64: "YR==" }))
        .status,
    ).toBe(409);
    expect(
      (
        await call("chunk", {
          ...transfer(item),
          offset: 0,
          base64: Buffer.from("four").toString("base64"),
        })
      ).status,
    ).toBe(409);
    expect((await call("commit", commit(item))).status).toBe(409);
    await fill(item, Buffer.from("bad"));
    expect((await call("commit", commit(item))).status).toBe(409);
    expect(count()).toBe(before);
    expect(
      (
        await call("receipt", {
          ...admission(item.commandId),
          payloadDigest: item.payloadDigest,
        })
      ).body.response.receipt,
    ).toBeNull();
  } finally {
    await call("close", transfer(item));
  }
  const empty = await prepare(manifest(Buffer.alloc(0)));
  expect(
    (await call("commit", commit(empty))).body.response.receipt,
  ).toMatchObject({ state: "completed", result: { size: 0 } });
});

it("bounds staging capacity and reclaims cancellation, idle expiry and total expiry", async () => {
  const first = await prepare(manifest(Buffer.from("one"))),
    second = await prepare(manifest(Buffer.from("two")));
  expect(
    (
      await call("prepare", {
        ...admission(randomUUID()),
        input: manifest(Buffer.from("three")),
      })
    ).status,
  ).toBe(503);
  await call("close", transfer(first));
  const third = await prepare(manifest(Buffer.from("three")));
  clock += 30_001;
  expect(
    (await call("chunk", { ...transfer(second), offset: 0, base64: "YQ==" }))
      .status,
  ).toBe(404);
  expect(
    (await call("chunk", { ...transfer(third), offset: 0, base64: "YQ==" }))
      .status,
  ).toBe(404);
  const controller = new AbortController(),
    input = manifest(Buffer.from("cancelled"));
  const cancelled = uploads.prepare(
    { ...admission(randomUUID()), input },
    controller.signal,
  );
  controller.abort();
  expect(
    (
      await call("chunk", {
        ...admission(cancelled.response.commandId),
        transferId: cancelled.response.transferId,
        payloadDigest: fleetPayloadDigest(input),
        offset: 0,
        base64: "YQ==",
      })
    ).status,
  ).toBe(404);
  const total = await prepare(manifest(Buffer.from("abcdefg")));
  for (let offset = 0; offset < 5; offset++) {
    clock += 20_000;
    expect(
      (await call("chunk", { ...transfer(total), offset, base64: "YQ==" }))
        .status,
    ).toBe(200);
  }
  clock += 19_000;
  expect(
    (await call("chunk", { ...transfer(total), offset: 5, base64: "YQ==" }))
      .status,
  ).toBe(200);
  clock += 1001;
  expect(
    (await call("chunk", { ...transfer(total), offset: 6, base64: "YQ==" }))
      .status,
  ).toBe(404);
});

it("recovers a lost commit reply from a replacement service without uploading twice", async () => {
  const bytes = Buffer.from("lost reply"),
    before = count(),
    calls = applied,
    item = await prepare(manifest(bytes));
  await fill(item, bytes);
  loseReply = true;
  try {
    expect(
      await call("commit", commit(item)).catch((error) => error),
    ).toBeInstanceOf(Error);
  } finally {
    loseReply = false;
  }
  expect(count()).toBe(before + 1);
  uploads.close();
  uploads = service();
  peerHttp = mount();
  const recovered = await call("receipt", {
    ...admission(item.commandId),
    payloadDigest: item.payloadDigest,
  });
  expect(recovered.body.response.receipt.state).toBe("completed");
  expect((await call("commit", commit(item))).body.response.receipt).toEqual(
    recovered.body.response.receipt,
  );
  expect(count()).toBe(before + 1);
  expect(applied).toBe(calls + 1);
});

it("keeps an uncertain owning effect unknown across retries and replacement", async () => {
  const bytes = Buffer.from("uncertain write"),
    before = count(),
    calls = applied,
    item = await prepare(manifest(bytes));
  await fill(item, bytes);
  throwAfterWrite = true;
  try {
    const reply = await call("commit", commit(item));
    expect(reply.body.response.receipt).toEqual({
      commandId: item.commandId,
      state: "unknown",
      result: null,
    });
    expect(JSON.stringify(reply.body)).not.toContain("private producer");
  } finally {
    throwAfterWrite = false;
  }
  uploads.close();
  uploads = service();
  peerHttp = mount();
  expect((await call("commit", commit(item))).body.response.receipt.state).toBe(
    "unknown",
  );
  expect(
    (await call("prepare", { ...admission(item.commandId), input: item.input }))
      .body.response,
  ).toMatchObject({ transferId: null, receipt: { state: "unknown" } });
  expect(count()).toBe(before + 1);
  expect(applied).toBe(calls + 1);
});

it("rechecks the owning upload transaction and records refusal before a revoked queued dispatch", async () => {
  const bytes = Buffer.from("revoked"),
    before = count(),
    calls = applied,
    item = await prepare(manifest(bytes));
  await fill(item, bytes);
  const admissionContext = credentials.authenticate(fileToken).context;
  let checks = 0;
  expect(() =>
    withFleetAction(
      { owner: OWNER, commandId: randomUUID(), grant: admissionContext },
      () => {
        if (++checks === 3)
          throw new Error("fixture revoke at owning transaction");
      },
      () =>
        uploadFile(OWNER, {
          originalname: "refused",
          mimetype: "text/plain",
          buffer: bytes,
        }),
    ),
  ).toThrow("owning transaction");
  expect(count()).toBe(before);
  const pending = uploads.commit(commit(item)).catch((error) => error);
  const removed = source.authority.revise(source.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(directory.document),
    members: directory.document.members.filter(
      (member) => member.machineId !== destination.identity.machineId,
    ),
  });
  destination.accept(OWNER, removed);
  expect(await pending).toBeInstanceOf(Error);
  expect(count()).toBe(before);
  expect(applied).toBe(calls);
  expect(
    uploads.localReceipt(item.commandId, item.payloadDigest),
  ).toMatchObject({ state: "refused", result: null });
  expect(
    (await call("prepare", { ...admission(randomUUID()), input: item.input }))
      .status,
  ).toBe(403);
  expect((await call("commit", commit(item))).status).toBe(403);
});
