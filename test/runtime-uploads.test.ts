import { afterAll, beforeEach, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import express from "express";
import {
  UPLOAD_CHUNK_BYTES,
  safeUploadName,
  uploadName,
  writeUploadChunk,
} from "../runtime/uploads.mjs";

const dir = mkdtempSync(join(tmpdir(), "loop-uploads-"));
process.env.LOOP_DATA_DIR = join(dir, "data");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { uploadFile } = await import("../src/server/uploads");
const { subscriptionStream } = await import("../src/server/subscriptions");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function send(root: string, bytes: Buffer, extra: object = {}) {
  const base = {
    fileId: randomUUID(),
    transferId: randomBytes(16).toString("hex"),
    name: "screenshot.png",
    size: bytes.length,
    sha256: sha(bytes),
    ...extra,
  };
  let offset = 0;
  for (;;) {
    const result = writeUploadChunk(root, {
      ...base,
      offset,
      data: bytes
        .subarray(offset, offset + UPLOAD_CHUNK_BYTES)
        .toString("base64"),
    });
    if (result.complete) return { ...base, ...result };
    offset = result.nextOffset!;
  }
}

it("reassembles chunked uploads atomically and reuses an identical copy", () => {
  const root = join(dir, "chunks");
  const bytes = randomBytes(UPLOAD_CHUNK_BYTES * 2 + 17);
  const first = send(root, bytes);
  expect(first.path).toBe(
    join(realpathSync(root), first.fileId, "screenshot.png"),
  );
  expect(readFileSync(first.path).equals(bytes)).toBe(true);
  expect(readdirSync(join(root, first.fileId))).toEqual(["screenshot.png"]);
  // A later turn sends only the first chunk and gets the existing copy back.
  expect(
    writeUploadChunk(root, {
      ...first,
      transferId: randomBytes(16).toString("hex"),
      offset: 0,
      data: bytes.subarray(0, UPLOAD_CHUNK_BYTES).toString("base64"),
    }),
  ).toEqual({
    path: first.path,
    size: bytes.length,
    complete: true,
    nextOffset: null,
  });
  const empty = send(root, Buffer.alloc(0), { name: "empty.txt" });
  expect(readFileSync(empty.path).length).toBe(0);
});

it("rejects unsafe names, gaps, oversized chunks and checksum mismatches", () => {
  const root = join(dir, "invalid");
  const bytes = randomBytes(UPLOAD_CHUNK_BYTES + 10);
  for (const name of ["../escape", "a/b", "..", ".", "", "bad\nname"])
    expect(() => send(root, bytes, { name })).toThrow("Invalid upload chunk");
  expect(() => send(root, bytes, { fileId: "../x" })).toThrow(
    "Invalid upload chunk",
  );
  const base = {
    fileId: randomUUID(),
    transferId: randomBytes(16).toString("hex"),
    name: "a.bin",
    size: bytes.length,
    sha256: sha(bytes),
  };
  expect(() =>
    writeUploadChunk(root, {
      ...base,
      offset: UPLOAD_CHUNK_BYTES,
      data: bytes.subarray(UPLOAD_CHUNK_BYTES).toString("base64"),
    }),
  ).toThrow();
  expect(() =>
    writeUploadChunk(root, {
      ...base,
      offset: 0,
      data: randomBytes(UPLOAD_CHUNK_BYTES + 3).toString("base64"),
    }),
  ).toThrow("Invalid upload chunk");
  expect(() => send(root, bytes, { sha256: "0".repeat(64) })).toThrow(
    "Upload checksum mismatch",
  );
  for (const entry of readdirSync(root))
    expect(readdirSync(join(root, entry))).toEqual([]);
});

it("keeps upload names within file system limits", () => {
  // 200 CJK characters are 600 bytes: over the 255-byte name limit.
  const long = "图".repeat(200) + ".png";
  expect(uploadName(long)).toBe(false);
  const short = safeUploadName(long);
  expect(short.endsWith(".png")).toBe(true);
  expect(Buffer.byteLength(short)).toBeLessThanOrEqual(255);
  expect(uploadName(short)).toBe(true);
  for (const name of ["a:b.txt", "what?.md", "CON", "nul.txt", "trailing."])
    expect(uploadName(name)).toBe(false);
  expect(safeUploadName("a:b.txt")).toBe("a_b.txt");
  expect(safeUploadName("CON")).toBe("_CON");
  expect(safeUploadName("")).toBe("file");
  const root = join(dir, "names");
  const bytes = randomBytes(10);
  expect(() => send(root, bytes, { name: long })).toThrow("Invalid upload chunk");
  expect(readFileSync(send(root, bytes, { name: short }).path).equals(bytes)).toBe(true);
});

it("refuses a symlinked upload folder and sweeps abandoned partial files", () => {
  const root = join(dir, "guard");
  mkdirSync(root, { recursive: true });
  const fileId = randomUUID();
  symlinkSync("..", join(root, fileId));
  expect(() => send(root, randomBytes(10), { fileId })).toThrow(
    "Upload directory escaped the workspace",
  );
  const other = randomUUID();
  const folder = join(root, other);
  mkdirSync(folder);
  const stale = join(folder, `.${"a".repeat(32)}.part`);
  const fresh = join(folder, `.${"b".repeat(32)}.part`);
  writeFileSync(stale, "old");
  writeFileSync(fresh, "new");
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(stale, old, old);
  send(root, randomBytes(10), { fileId: other, name: "x.bin" });
  expect(readdirSync(folder).sort()).toEqual([".bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.part", "x.bin"]);
});

const workspace = join(dir, "runtime-workspace");
const requests: any[] = [];
let failUploads = false;
const app = express();
app.use(express.json({ limit: "2mb" }));
app.post("/runtime", (req, res) => {
  requests.push(req.body);
  if (req.body.action === "write-upload") {
    expect(JSON.stringify(req.body).length).toBeLessThan(1_000_000);
    if (failUploads) {
      res.status(500).json({ error: "disk full" });
      return;
    }
    res.json(writeUploadChunk(join(workspace, ".loop", "uploads"), req.body));
    return;
  }
  res
    .type("application/x-ndjson")
    .end(
      [{ chunk: { text: "Seen" } }, { done: true }]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
process.env.LOOP_RUNTIME_URL = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.LOOP_ALLOWED_RUNTIME_ORIGINS = process.env.LOOP_RUNTIME_URL;
process.env.LOOP_RUNTIME_TOKEN =
  "upload-fixture-runtime-token-at-least-32-chars";
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});
beforeEach(() => {
  requests.length = 0;
  failUploads = false;
});

function connection() {
  const key = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice','anthropic','Claude','','connected','[]','{\"authMode\":\"subscription\"}',?)",
  ).run(key, now());
  return db.prepare("SELECT * FROM connections WHERE id=?").get(key) as any;
}
async function turn(c: any, attachments: any[]) {
  const input = {
    model: "claude-fixture",
    instructions: "",
    workspaceKey: "b".repeat(64),
    signal: new AbortController().signal,
    messages: [
      { role: "user" as const, content: "Earlier" },
      { role: "user" as const, content: "What is this?", attachments },
    ],
  };
  const chunks = [];
  for await (const chunk of subscriptionStream(c, input)) chunks.push(chunk);
  expect(chunks[0]).toEqual({ text: "Seen" });
  // The caller's history is not mutated; the runtime gets the staged prompt.
  expect(input.messages[1].content).toBe("What is this?");
  return requests.find((r) => r.action === "turn").input.messages[1].content;
}

it("copies the current turn's uploads into the runtime workspace before the turn", async () => {
  const bytes = randomBytes(Math.floor(UPLOAD_CHUNK_BYTES * 1.4));
  const image = uploadFile("alice", {
    originalname: "IMG_8960.png",
    mimetype: "image/png",
    buffer: bytes,
  });
  const c = connection();
  const content = await turn(c, [image]);
  const uploads = requests.filter((r) => r.action === "write-upload");
  expect(uploads.map((r) => r.offset)).toEqual([0, UPLOAD_CHUNK_BYTES]);
  expect(new Set(uploads.map((r) => r.workspaceKey))).toEqual(
    new Set(["b".repeat(64)]),
  );
  const path = join(workspace, ".loop", "uploads", image.id, "IMG_8960.png");
  expect(readFileSync(path).equals(bytes)).toBe(true);
  expect(content).toContain("Use native file tools to inspect them");
  expect(content).toContain(JSON.stringify(path));
  expect(content).not.toContain("could not be copied");
  // Later rounds of the run confirm the copy is still there and reuse it
  // without re-sending bytes.
  requests.length = 0;
  expect(await turn(c, [image])).toContain(JSON.stringify(path));
  expect(requests.map((r) => r.action)).toEqual(["write-upload", "turn"]);
  expect(requests[0]).toMatchObject({ check: true });
  expect(requests[0].data).toBeUndefined();
  // A runtime restart or recreated workspace removes the copy: the next turn
  // stages it again instead of pointing at a missing path.
  rmSync(join(workspace, ".loop", "uploads", image.id), { recursive: true });
  requests.length = 0;
  expect(await turn(c, [image])).toContain(JSON.stringify(path));
  expect(
    requests.filter((r) => r.action === "write-upload").map((r) => r.check ? "check" : r.offset),
  ).toEqual(["check", 0, UPLOAD_CHUNK_BYTES]);
  expect(readFileSync(path).equals(bytes)).toBe(true);
  // A different connection re-checks the workspace but sends only one chunk.
  requests.length = 0;
  await turn(connection(), [image]);
  expect(requests.map((r) => r.action)).toEqual(["write-upload", "turn"]);
});

it("falls back to loop_read_file when the runtime cannot store an upload", async () => {
  failUploads = true;
  const file = uploadFile("alice", {
    originalname: "notes.pdf",
    mimetype: "application/pdf",
    buffer: randomBytes(1000),
  });
  const content = await turn(connection(), [file]);
  expect(content).toContain(
    `These files could not be copied to this machine: ["${file.id}"]. Use loop_read_file`,
  );
  expect(content).not.toContain("Use native file tools");
  expect(existsSync(join(workspace, ".loop", "uploads", file.id))).toBe(false);
});

it("stores uploads through a native-host broker outside the project directory", async () => {
  const project = mkdtempSync(join(dir, "project-"));
  const home = mkdtempSync(join(dir, "home-"));
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const token = "broker-upload-test-token-at-least-32-characters";
  const broker = spawn(process.execPath, ["runtime/broker.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      LOOP_RUNTIME_MODE: "host",
      LOOP_RUNTIME_WORKDIR: project,
      LOOP_RUNTIME_TOKEN: token,
      PORT: String(port),
    },
    stdio: "ignore",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      ready = await fetch(url + "/health", {
        headers: { authorization: `Bearer ${token}` },
      }).then(
        (r) => r.ok,
        () => false,
      );
      if (!ready) await new Promise((r) => setTimeout(r, 50));
    }
    expect(ready).toBe(true);
    const bytes = randomBytes(UPLOAD_CHUNK_BYTES);
    const fileId = randomUUID();
    const response = await fetch(url + "/runtime", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "a".repeat(64),
        provider: "claude",
        action: "write-upload",
        fileId,
        transferId: randomBytes(16).toString("hex"),
        name: "photo.png",
        size: bytes.length,
        sha256: sha(bytes),
        offset: 0,
        data: bytes.toString("base64"),
      }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ complete: true, size: bytes.length });
    expect(result.path).toBe(
      join(home, ".loop", "uploads", fileId, "photo.png"),
    );
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
    expect(readdirSync(project)).toEqual([]);
  } finally {
    broker.kill("SIGTERM");
    await new Promise<void>((r) => broker.once("close", () => r()));
  }
});
