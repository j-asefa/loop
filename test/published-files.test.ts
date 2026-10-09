import { afterAll, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import express from "express";
import {
  readPublishedChunk,
  FileRejected,
  FILE_CHUNK_BYTES,
  MAX_PUBLISHED_BYTES,
} from "../runtime/published-files.mjs";

const directory = mkdtempSync(join(tmpdir(), "loop-published-"));
const workspace = join(directory, "workspace");
mkdirSync(workspace);
process.env.LOOP_DATA_DIR = join(directory, "data");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP_PROFILE = "server";
const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit } = await import("../src/server/agent-runtime");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools");
const { publishRunFile } = await import("../src/server/published-files");
const { runtimeKey, runtimeWorkspaceKey } =
  await import("../src/server/subscriptions");
const { core } = await import("../src/server/core-routes");
const { workspace: routes } = await import("../src/server/workspace-routes");
const { feedRevision, feedUpdates } = await import("../src/server/feed");
const { agentMessages } = await import("../src/server/agent-messages");
const requests: any[] = [];
let changeTransfer: ((chunk: any) => any) | undefined;
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.post("/runtime", (req, res) => {
  requests.push(req.body);
  expect(req.get("authorization")).toBe(
    "Bearer " + process.env.LOOP_RUNTIME_TOKEN,
  );
  expect(req.body.action).toBe("read-file");
  if (req.body.path === "outage.bin") {
    res.status(422).json({ error: "Subscription runtime unavailable" });
    return;
  }
  let chunk;
  try {
    chunk = readPublishedChunk(
      workspace,
      req.body.path,
      req.body.offset,
      req.body.version,
    );
  } catch (error) {
    // The broker's contract for a refused file (test/runtime-file-broker).
    if (!(error instanceof FileRejected)) throw error;
    res.status(422).json({ code: "file_rejected", error: error.message });
    return;
  }
  res.json(changeTransfer ? changeTransfer(chunk) : chunk);
});
app.use("/api", core, routes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 400).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.LOOP_RUNTIME_URL = base;
process.env.LOOP_ALLOWED_RUNTIME_ORIGINS = base;
process.env.LOOP_RUNTIME_TOKEN =
  "file-fixture-runtime-token-at-least-32-characters";
const request = (path: string, owner = "alice") =>
  fetch(base + "/api" + path, { headers: { "x-owner": owner } });
function fixture() {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice','codex','Fixture',?,'connected','[{\"id\":\"gpt-6-astra\"}]','{\"authMode\":\"subscription\"}',?)",
  ).run(connection, seal("fixture", "alice"), now());
  const agent = createAgent("alice", {
    name: "publisher-" + id().slice(0, 8),
    connectionId: connection,
    model: "gpt-6-astra",
  });
  const run = submit("alice", {
    agentId: agent.id,
    input: "Create a mockup and publish it",
    idempotencyKey: id(),
  });
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  const binding = nativeBindings(run).find(
    (b) => b.tool === "loop_publish_file",
  )!;
  return {
    agent,
    run: { ...run, state: "running" },
    binding,
    connection: db
      .prepare("SELECT * FROM connections WHERE id=?")
      .get(connection) as any,
  };
}
async function publish(
  f: ReturnType<typeof fixture>,
  args: Record<string, unknown>,
  call = id(),
) {
  const outcome = await invokeNative(f.run, f.binding, call, args);
  if (!("result" in outcome))
    throw new Error("Publication must not wait for approval");
  return {
    ...outcome,
    value: JSON.parse(outcome.result.content[0].text),
    call,
  };
}
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("publishes chunked workspace files, persists them after failure, and keeps results separate", async () => {
  const f = fixture(),
    bytes = randomBytes(FILE_CHUNK_BYTES * 2 + 7),
    path = "mockup.png";
  writeFileSync(join(workspace, path), bytes);
  requests.length = 0;
  const revision = feedRevision("alice");
  const saved = await publish(f, { path, title: "Home screen" });
  expect(saved.result.isError).not.toBe(true);
  expect(saved.value).toMatchObject({
    name: path,
    mime: "image/png",
    size: bytes.length,
    available: true,
  });
  expect(requests.map((r) => r.offset)).toEqual([
    0,
    FILE_CHUNK_BYTES,
    FILE_CHUNK_BYTES * 2,
  ]);
  expect(
    requests.every(
      (r) =>
        r.workspaceKey === runtimeWorkspaceKey("alice", f.agent.id) &&
        r.key === runtimeKey(f.connection),
    ),
  ).toBe(true);
  const files = await (
    await request(`/feed?agent=${f.agent.id}&view=files`)
  ).json();
  expect(files.items.map((item: any) => item.id)).toContain(saved.artifactId);
  expect(
    feedUpdates("alice", {
      after: revision,
      through: 0,
      view: "files",
    }).items.map((item) => item.id),
  ).toContain(saved.artifactId);
  expect(
    (await (await request(`/feed?agent=${f.agent.id}`)).json()).items,
  ).toEqual([]);
  const response = await request(
    `/artifacts/${saved.artifactId}/file?preview=1`,
  );
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(
    (await request(`/artifacts/${saved.artifactId}/file`)).headers.get(
      "content-disposition",
    ),
  ).toContain("attachment; filename*=UTF-8''mockup.png");
  const filesByRun = await (await request(`/runs/${f.run.id}/files`)).json();
  expect(filesByRun[0]).toMatchObject({
    id: saved.artifactId,
    title: "Home screen",
  });
  expect(filesByRun[0]).not.toHaveProperty("content");
  expect((await request(`/runs/${f.run.id}/files`, "bob")).status).toBe(404);
  expect(
    (await request(`/artifacts/${saved.artifactId}/file`, "bob")).status,
  ).toBe(404);
  // Retry after the runtime file disappears, including recovery between object
  // commit and the native tool receipt, must return the same stored artifact.
  rmSync(join(workspace, path));
  db.prepare(
    "UPDATE native_calls SET result=NULL WHERE run_id=? AND call_id=?",
  ).run(f.run.id, saved.call);
  const retried = await publish(f, { path, title: "Home screen" }, saved.call);
  expect(retried.artifactId).toBe(saved.artifactId);
  expect(requests).toHaveLength(3);
  await expect(
    invokeNative(f.run, f.binding, saved.call, {
      path: "other.png",
      title: "Home screen",
    }),
  ).rejects.toThrow("identity was reused");
  db.prepare("UPDATE runs SET state='failed' WHERE id=?").run(f.run.id);
  expect(
    (
      await (await request(`/feed?agent=${f.agent.id}&view=files`)).json()
    ).items.map((item: any) => item.id),
  ).toContain(saved.artifactId);
  expect((await request(`/artifacts/${saved.artifactId}/file`)).ok).toBe(true);
});

it("makes small text files downloadable, with safe names and no inline active content", async () => {
  const f = fixture();
  const saved = await publish(f, {
    title: "résumé's.html",
    content: "<script>alert(1)</script>",
  });
  const response = await request(
    `/artifacts/${saved.artifactId}/file?preview=1`,
  );
  expect(response.headers.get("content-disposition")).toContain(
    "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%27s.html",
  );
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("<script>alert(1)</script>");
  const artifact = await (
    await request(`/artifacts/${saved.artifactId}`)
  ).json();
  expect(JSON.parse(artifact.metadata)).toMatchObject({
    uploaded: true,
    text: true,
    model: "gpt-6-astra",
  });
  expect(artifact.content).toBe("<script>alert(1)</script>");
  const messagesId = id();
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
    messagesId,
    "alice",
    f.run.conversation_id,
    f.run.id,
    "assistant",
    "Published your file",
    "{}",
    now(),
  );
  expect(agentMessages("alice", f.agent.id).items[0].model).toBe("gpt-6-astra");
  db.prepare("UPDATE agents SET model='changed-model' WHERE id=?").run(
    f.agent.id,
  );
  expect(agentMessages("alice", f.agent.id).items[0].model).toBe("gpt-6-astra");
});

it("renders complete HTML only in an explicitly requested, owner-scoped sandbox", async () => {
  const f = fixture();
  const html =
    "<!doctype html><title>Mockup</title><button onclick=\"this.textContent='Done'\">Try it</button>";
  const saved = await publish(f, { title: "résumé's.html", content: html });
  const path = `/artifacts/${saved.artifactId}/file`;
  const response = await request(path + "?preview=html");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-disposition")).toBe(
    "inline; filename*=UTF-8''r%C3%A9sum%C3%A9%27s.html",
  );
  const policy = response.headers.get("content-security-policy");
  expect(policy).toContain("sandbox allow-scripts");
  expect(policy).not.toContain("allow-same-origin");
  expect(policy).toContain("connect-src 'none'");
  expect(policy).toContain("form-action 'none'");
  expect(policy).toContain("font-src data:");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.text()).toBe(html);
  expect((await request(path + "?preview=html", "bob")).status).toBe(404);
  expect((await request(path)).headers.get("content-disposition")).toMatch(
    /^attachment;/,
  );
});

it("supports HTML upload previews without treating other file types as active documents", async () => {
  const { uploadFile } = await import("../src/server/uploads");
  for (const [name, mime, html] of [
    ["PAGE.HTM", "application/octet-stream", true],
    ["prototype", "text/html; charset=utf-8", true],
    ["page.xhtml", "application/xhtml+xml", true],
    ["notes.txt", "text/plain", false],
    ["icon.svg", "image/svg+xml", false],
  ] as const) {
    const bytes = Buffer.from(
      "<!doctype html><p>" + "Full content ".repeat(12_000) + "</p>",
    );
    const saved = uploadFile("alice", {
      originalname: name,
      mimetype: mime,
      buffer: bytes,
    });
    const path = `/objects/${saved.objectId}`;
    const response = await request(path + "?preview=html");
    expect(response.headers.get("content-disposition")).toMatch(
      html ? /^inline;/ : /^attachment;/,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect((await request(path + "?preview=html", "bob")).status).toBe(404);
    expect((await request(path)).headers.get("content-disposition")).toMatch(
      /^attachment;/,
    );
  }
});

it("rejects changed, corrupt, and cancelled transfers without publishing a partial file", async () => {
  const f = fixture();
  writeFileSync(
    join(workspace, "report.pdf"),
    randomBytes(FILE_CHUNK_BYTES + 4),
  );
  for (const corrupt of [
    (chunk: any) => ({ ...chunk, base64: chunk.base64 + "!" }),
    (chunk: any) => ({ ...chunk, offset: chunk.offset + 1 }),
    (chunk: any) => ({
      ...chunk,
      version: chunk.offset ? "changed" : chunk.version,
    }),
  ]) {
    changeTransfer = corrupt;
    const outcome = await invokeNative(f.run, f.binding, id(), {
      path: "report.pdf",
      title: "Report",
    });
    expect("result" in outcome && outcome.result.isError).toBe(true);
    expect(
      db
        .prepare("SELECT count(*) n FROM artifact_objects WHERE run_id=?")
        .get(f.run.id),
    ).toEqual({ n: 0 });
  }
  changeTransfer = (chunk) => {
    db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(f.run.id);
    return chunk;
  };
  try {
    await expect(
      publishRunFile(f.run, id(), {
        path: "report.pdf",
        title: "Report",
        encoding: "utf8",
      }),
    ).rejects.toThrow("no longer executing");
    expect(
      db
        .prepare("SELECT count(*) n FROM artifact_objects WHERE run_id=?")
        .get(f.run.id),
    ).toEqual({ n: 0 });
  } finally {
    changeTransfer = undefined;
  }
});

it("tells the agent why a workspace file was refused, unlike a runtime outage", async () => {
  const f = fixture();
  writeFileSync(join(workspace, "review-30fps.mp4"), "");
  truncateSync(join(workspace, "review-30fps.mp4"), 49 * 1024 * 1024);
  const text = async (path: string) => {
    const outcome = await invokeNative(f.run, f.binding, id(), {
      path,
      title: "Review cut",
    });
    if (!("result" in outcome)) throw new Error("Expected a result");
    expect(outcome.result.isError).toBe(true);
    return outcome.result.content[0].text;
  };
  expect(await text("review-30fps.mp4")).toBe(
    "File was not published: This file is 49.0 MB; Loop publishes files up to 25 MB. Make it smaller, for example by compressing or splitting it, then publish again.",
  );
  expect(await text("outage.bin")).toMatch(
    /^File was not published: Subscription runtime unavailable or busy \(HTTP 422\)/,
  );
  expect(
    db
      .prepare("SELECT count(*) n FROM artifact_objects WHERE run_id=?")
      .get(f.run.id),
  ).toEqual({ n: 0 });
});

it("confines published files to regular nonsecret workspace files", () => {
  writeFileSync(join(directory, "outside.txt"), "outside");
  mkdirSync(join(workspace, ".private"));
  writeFileSync(join(workspace, ".private", "notes.txt"), "private");
  writeFileSync(join(workspace, "credentials.json"), "credentials");
  symlinkSync(join(directory, "outside.txt"), join(workspace, "escape.txt"));
  symlinkSync(
    join(workspace, ".private", "notes.txt"),
    join(workspace, "hidden-link.txt"),
  );
  symlinkSync(
    join(workspace, "credentials.json"),
    join(workspace, "alias.txt"),
  );
  linkSync(join(directory, "outside.txt"), join(workspace, "hardlink.txt"));
  for (const path of [
    "../outside.txt",
    join(directory, "outside.txt"),
    ".private/notes.txt",
    "credentials.json",
    "escape.txt",
    "hidden-link.txt",
    "alias.txt",
    "hardlink.txt",
  ])
    expect(() => readPublishedChunk(workspace, path)).toThrow();
  writeFileSync(join(workspace, "large.zip"), "");
  truncateSync(join(workspace, "large.zip"), MAX_PUBLISHED_BYTES + 1);
  expect(() => readPublishedChunk(workspace, "large.zip")).toThrow("25 MB");
  writeFileSync(
    join(workspace, "changing.txt"),
    "a".repeat(FILE_CHUNK_BYTES + 4),
  );
  const first = readPublishedChunk(workspace, "changing.txt");
  writeFileSync(
    join(workspace, "changing.txt"),
    "b".repeat(FILE_CHUNK_BYTES + 4),
  );
  expect(() =>
    readPublishedChunk(
      workspace,
      "changing.txt",
      first.nextOffset!,
      first.version,
    ),
  ).toThrow("changed");
});

it("reads files through the real runtime entry without launching a provider", () => {
  const home = join(directory, "runtime-home"),
    key = "a".repeat(64),
    path = join(home, "workspaces", key);
  mkdirSync(path, { recursive: true });
  const bytes = randomBytes(FILE_CHUNK_BYTES + 12);
  writeFileSync(join(path, "diagram.webp"), bytes);
  let version: string | undefined;
  const chunks = [];
  for (const offset of [0, FILE_CHUNK_BYTES]) {
    const stdout = execFileSync(
      process.execPath,
      [resolve("runtime/entry.mjs")],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          LOOP_RUNTIME_MODE: "container",
        },
        input:
          JSON.stringify({
            provider: "codex",
            action: "read-file",
            workspaceKey: key,
            path: "diagram.webp",
            offset,
            version,
          }) + "\n",
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10000,
      },
    );
    const chunk = JSON.parse(stdout.trim()).result;
    expect(chunk.mime).toBe("image/webp");
    version = chunk.version;
    chunks.push(Buffer.from(chunk.base64, "base64"));
  }
  expect(Buffer.concat(chunks)).toEqual(bytes);
});
