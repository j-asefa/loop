import { afterAll, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  truncateSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import {
  readPublishedChunk,
  FILE_CHUNK_BYTES,
  MAX_PUBLISHED_BYTES,
} from "../runtime/published-files.ts";

const directory = mkdtempSync(join(tmpdir(), "loop-published-"));
const workspace = join(directory, "workspace");
mkdirSync(workspace);
process.env.LOOP_DATA_DIR = join(directory, "data");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit } = await import("../src/server/agent-runtime");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools");
const { publishRunFile } = await import("../src/server/published-files");
const { core } = await import("../src/server/core-routes");
const { workspace: routes } = await import("../src/server/workspace-routes");
const { resultsRevision, resultsUpdates } =
  await import("../src/server/results");
const { agentMessages } = await import("../src/server/agent-messages");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use("/api", core, routes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 400).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const request = (path: string, owner = "alice") =>
  fetch(base + "/api" + path, { headers: { "x-owner": owner } });
function fixture() {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice','codex','Fixture',?,'connected','[{\"id\":\"gpt-6-astra\"}]','{\"loopHarness\":\"codex\"}',?)",
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
  // The conversation's native session works in this computer's project.
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,project,generation,updated_at) VALUES(?,'codex',?,?,?)",
  ).run(run.conversation_id, workspace, id(), now());
  const binding = nativeBindings(run).find(
    (b) => b.tool === "loop_publish_file",
  )!;
  return {
    agent,
    run: { ...run, state: "running" as const },
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
  const revision = resultsRevision("alice");
  const saved = await publish(f, { path, title: "Home screen" });
  expect(saved.result.isError).not.toBe(true);
  const { parseArtifact } = await import("../src/server/row-schemas");
  expect(
    parseArtifact(
      db.prepare("SELECT * FROM artifacts WHERE id=?").get(saved.artifactId),
    ).metadata,
  ).toMatchObject({
    uploaded: true,
    name: path,
    mime: "image/png",
    size: bytes.length,
  });
  expect(saved.value).toMatchObject({
    name: path,
    mime: "image/png",
    size: bytes.length,
    available: true,
  });
  const files = await (
    await request(`/results?agent=${f.agent.id}&view=files`)
  ).json();
  expect(files.items.map((item: any) => item.id)).toContain(saved.artifactId);
  expect(
    resultsUpdates("alice", {
      after: revision,
      through: 0,
      view: "files",
    }).items.map((item) => item.id),
  ).toContain(saved.artifactId);
  expect(
    (await (await request(`/results?agent=${f.agent.id}`)).json()).items,
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
  // Retry after the workspace file disappears, including recovery between object
  // commit and the native tool receipt, must return the same stored artifact.
  rmSync(join(workspace, path));
  db.prepare(
    "UPDATE native_calls SET result=NULL WHERE run_id=? AND call_id=?",
  ).run(f.run.id, saved.call);
  const retried = await publish(f, { path, title: "Home screen" }, saved.call);
  expect(retried.artifactId).toBe(saved.artifactId);
  await expect(
    invokeNative(f.run, f.binding, saved.call, {
      path: "other.png",
      title: "Home screen",
    }),
  ).rejects.toThrow("identity was reused");
  db.prepare("UPDATE runs SET state='failed' WHERE id=?").run(f.run.id);
  expect(
    (
      await (await request(`/results?agent=${f.agent.id}&view=files`)).json()
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
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
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

it("does not publish a workspace file once its run stops executing", async () => {
  const f = fixture();
  writeFileSync(
    join(workspace, "report.pdf"),
    randomBytes(FILE_CHUNK_BYTES + 4),
  );
  db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(f.run.id);
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
});

it("tells the agent why a workspace file was refused", async () => {
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
  // Make the version change deterministic on filesystems with coarse timestamps.
  const changedAt = new Date(Date.now() + 2000);
  utimesSync(join(workspace, "changing.txt"), changedAt, changedAt);
  expect(() =>
    readPublishedChunk(
      workspace,
      "changing.txt",
      first.nextOffset!,
      first.version,
    ),
  ).toThrow("changed");
});

it("lists durable profile files independently of feed visibility, with private filters and pagination", async () => {
  const f = fixture();
  const project = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,'alice','File library project','project',?)",
  ).run(project, now());
  const ids: string[] = [];
  for (let i = 0; i < 42; i++) {
    const saved = await publish(f, {
      title: `library-${i}.html`,
      content: `<h1>${i}</h1>`,
    });
    ids.push(saved.artifactId);
  }
  db.prepare(
    "UPDATE artifacts SET feed_hidden=1,archived=1,folder_id=? WHERE agent_id=?",
  ).run(project, f.agent.id);
  const child = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,name,kind,parent_id,created_at) VALUES(?,'alice','Deliverables','folder',?,?)",
  ).run(child, project, now());
  db.prepare("UPDATE artifacts SET folder_id=? WHERE id=?").run(child, ids[0]);
  const url = `/me/files?agent=${f.agent.id}`;
  const first = await (await request(url)).json();
  expect(first.items).toHaveLength(40);
  expect(first.items.map((file: any) => file.id)).toEqual(
    ids.slice(2).reverse(),
  );
  expect(first.items[0]).toMatchObject({
    agent_name: f.agent.name,
    project_name: "File library project",
    conversation_id: f.run.conversation_id,
  });
  expect(JSON.parse(first.items[0].metadata)).toMatchObject({
    name: "library-41.html",
    mime: "text/html",
  });
  const second = await (await request(`${url}&before=${first.next}`)).json();
  expect(second.items.map((file: any) => file.id)).toEqual(
    ids.slice(0, 2).reverse(),
  );
  expect(second.next).toBeNull();
  const nested = await (
    await request(`${url}&q=library-0&project=${project}`)
  ).json();
  expect(nested.items.map((file: any) => file.id)).toEqual([ids[0]]);
  expect(nested.projects.map((folder: any) => folder.id)).toContain(project);
  const search = await (
    await request(`${url}&q=LIBRARY-41&type=html&project=${project}`)
  ).json();
  expect(search.items.map((file: any) => file.id)).toEqual([ids[41]]);
  expect((await (await request(`${url}&type=image`)).json()).items).toEqual([]);
  const other = await (await request("/me/files", "bob")).json();
  expect(other).toEqual({ items: [], next: null, agents: [], projects: [] });
  expect((await request(url, "bob")).status).toBe(404);
  expect((await request(`/me/files?project=${project}`, "bob")).status).toBe(
    404,
  );
  expect((await request("/me/files?before=-1")).status).toBe(400);
  expect((await request(`/artifacts/${ids[41]}/file`, "bob")).status).toBe(404);
  expect(await (await request(`/artifacts/${ids[41]}/file`)).text()).toBe(
    "<h1>41</h1>",
  );
});

it("publishes video MIME types for playback and library filtering", async () => {
  const f = fixture();
  const saved = await publish(f, {
    title: "clip.mp4",
    content: "video fixture",
  });
  expect(saved.value.mime).toBe("video/mp4");
  const page = await (
    await request(`/me/files?agent=${f.agent.id}&type=video`)
  ).json();
  expect(page.items.map((file: any) => file.id)).toEqual([saved.artifactId]);
  expect(
    (await request(saved.value.downloadUrl.replace("/api", ""))).headers.get(
      "content-type",
    ),
  ).toContain("video/mp4");
});
