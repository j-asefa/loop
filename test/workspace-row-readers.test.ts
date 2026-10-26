import { afterAll, beforeAll, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { DEFINITION_EXAMPLES } from "../src/shared/agent-definitions";

const directory = mkdtempSync(join(tmpdir(), "loop-workspace-row-readers-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { saveArtifact } = await import("../src/server/artifacts");
const { enqueue } = await import("../src/server/queue");
const { teams } = await import("../src/server/teams");
const { agentDefinitions } = await import("../src/server/agent-definitions");
const { workspace } = await import("../src/server/workspace-routes");
const { prWatches } = await import("../src/server/pr-watches");
const { errorHandler } = await import("../src/server/error-handler");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use(teams, agentDefinitions, workspace, prWatches, errorHandler);
let server: ReturnType<typeof app.listen>, origin: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
async function request(
  owner: string,
  path: string,
  body: object | undefined,
  method = "POST",
) {
  const response = await fetch(origin + path, {
    method,
    headers: { "content-type": "application/json", "x-owner": owner },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
function fixture() {
  const owner = id(),
    connection = id(),
    folder = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    owner,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture", effortLevels: [{ value: "high" }] }]),
    now(),
  );
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Fixture',?)",
  ).run(folder, owner, now());
  const agent = () =>
    createAgent(owner, {
      name: "typed-" + id().slice(0, 8),
      connectionId: connection,
      model: "fixture",
    });
  return { owner, connection, folder, manager: agent(), member: agent() };
}
const count = (table: "agents" | "teams" | "pr_watches") =>
  db.prepare(`SELECT count(*) n FROM ${table}`).get();

it("creates teams with legacy display defaults but rejects malformed connection catalogs without partial writes", async () => {
  const f = fixture(),
    body = {
      name: "Fixture team",
      managerId: f.manager.id,
      members: [f.member.id],
    };
  const created = await request(f.owner, "/teams", body);
  expect(created.status).toBe(201);
  expect(created.data.conversation_id).toEqual(expect.any(String));
  expect(created.data.members).toHaveLength(1);
  const before = count("teams");
  db.prepare(
    'UPDATE connections SET models=\'[{"id":"fixture","name":42}]\' WHERE id=?',
  ).run(f.connection);
  expect((await request("foreign", "/teams", body)).status).toBe(404);
  const rejected = await request(f.owner, "/teams", {
    ...body,
    name: "Unavailable",
  });
  expect(rejected).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining(f.connection) },
  });
  expect(count("teams")).toEqual(before);
});

it.each(["high", null, undefined])(
  "validates definition choices and idempotent receipts with effort %s",
  async (effort) => {
    const f = fixture(),
      definition = id();
    expect(
      (
        await request(
          f.owner,
          `/agent-definitions/${definition}`,
          { markdown: DEFINITION_EXAMPLES.agent, version: 0 },
          "PUT",
        )
      ).status,
    ).toBe(200);
    const body = {
      version: 1,
      selection: { connectionId: f.connection, model: "fixture", effort },
      name: "created-" + id().slice(0, 8),
      idempotencyKey: id(),
    };
    const created = await request(
      f.owner,
      `/agent-definitions/${definition}/create`,
      body,
    );
    expect(created.status).toBe(201);
    const agentId = created.data.agent.id,
      before = count("agents");
    expect(
      (await request(f.owner, `/agent-definitions/${definition}/create`, body))
        .data.agent.id,
    ).toBe(agentId);
    db.prepare("UPDATE agents SET created_at='invalid-time' WHERE id=?").run(
      agentId,
    );
    expect(
      (
        await request(
          "foreign",
          `/agent-definitions/${definition}/create`,
          body,
        )
      ).status,
    ).toBe(404);
    const replay = await request(
      f.owner,
      `/agent-definitions/${definition}/create`,
      body,
    );
    expect(replay).toMatchObject({
      status: 409,
      data: { error: expect.stringContaining(agentId) },
    });
    expect(count("agents")).toEqual(before);
    db.prepare(
      'UPDATE connections SET models=\'[{"id":"fixture","name":42}]\' WHERE id=?',
    ).run(f.connection);
    const rejected = await request(
      f.owner,
      `/agent-definitions/${definition}/create`,
      { ...body, name: "rejected-" + id().slice(0, 8), idempotencyKey: id() },
    );
    expect(rejected).toMatchObject({
      status: 409,
      data: { error: expect.stringContaining(f.connection) },
    });
    expect(count("agents")).toEqual(before);
  },
);

it("files and undoes a historical artifact while refusing malformed metadata and operation versions", async () => {
  const f = fixture(),
    metadata = { historicalLabel: "Kept" };
  const artifact = saveArtifact(f.owner, {
    title: "Fixture",
    content: "Fixture",
  });
  // Historical extras are read compatibility, not permitted new-write input.
  db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
    JSON.stringify(metadata),
    artifact,
  );
  const move = await request(f.owner, `/artifacts/${artifact}/move`, {
    folderId: f.folder,
  });
  expect(move.status).toBe(200);
  expect(
    (await request("foreign", `/operations/${move.data.operation}/undo`, {}))
      .status,
  ).toBe(404);
  expect(
    (await request(f.owner, `/operations/${move.data.operation}/undo`, {}))
      .status,
  ).toBe(200);
  const saved = db
    .prepare("SELECT folder_id,version,metadata FROM artifacts WHERE id=?")
    .get(artifact);
  expect(saved).toMatchObject({
    folder_id: null,
    metadata: JSON.stringify(metadata),
  });
  const invalid = '{"reviewId":null}';
  db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
    invalid,
    artifact,
  );
  expect(
    (
      await request("foreign", `/artifacts/${artifact}/move`, {
        folderId: f.folder,
      })
    ).status,
  ).toBe(404);
  expect(
    await request(f.owner, `/artifacts/${artifact}/move`, {
      folderId: f.folder,
    }),
  ).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining(artifact) },
  });
  expect(
    db
      .prepare("SELECT folder_id,metadata FROM artifacts WHERE id=?")
      .get(artifact),
  ).toEqual({ folder_id: null, metadata: invalid });
  db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
    JSON.stringify(metadata),
    artifact,
  );
  const second = await request(f.owner, `/artifacts/${artifact}/move`, {
    folderId: f.folder,
  });
  db.prepare(
    "UPDATE operations SET expected_version='invalid-version' WHERE id=?",
  ).run(second.data.operation);
  expect(
    await request(f.owner, `/operations/${second.data.operation}/undo`, {}),
  ).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining(second.data.operation) },
  });
  expect(
    db.prepare("SELECT folder_id FROM artifacts WHERE id=?").get(artifact),
  ).toEqual({ folder_id: f.folder });
});

it("rejects a damaged PR card before registering a watch and preserves the owner boundary", async () => {
  const f = fixture(),
    artifact = saveArtifact(f.owner, {
      title: "PR",
      content: "{}",
      kind: "github_pr",
    });
  db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
    '{"reviewId":null}',
    artifact,
  );
  const body = {
      artifactId: artifact,
      owner: "fixture",
      repo: "repo",
      number: 1,
    },
    before = count("pr_watches");
  expect((await request("foreign", "/pr-watches", body)).status).toBe(404);
  expect(await request(f.owner, "/pr-watches", body)).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining(artifact) },
  });
  expect(count("pr_watches")).toEqual(before);
});

it("keeps artifact metadata serialized and rejects malformed edits before writing", async () => {
  const f = fixture(),
    artifact = saveArtifact(f.owner, { title: "Original", content: "Body" });
  db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
    '{"historicalLabel":"kept"}',
    artifact,
  );
  const read = await request(
    f.owner,
    `/artifacts/${artifact}`,
    undefined,
    "GET",
  );
  expect(read).toMatchObject({
    status: 200,
    data: { metadata: '{"historicalLabel":"kept"}' },
  });
  const edited = await request(
    f.owner,
    `/artifacts/${artifact}`,
    { title: "Edited", version: read.data.version },
    "PATCH",
  );
  expect(edited).toMatchObject({
    status: 200,
    data: { title: "Edited", metadata: '{"historicalLabel":"kept"}' },
  });
  db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
    '{"reviewId":null}',
    artifact,
  );
  expect(
    (await request("foreign", `/artifacts/${artifact}`, undefined, "GET"))
      .status,
  ).toBe(404);
  expect(
    await request(f.owner, `/artifacts/${artifact}`, undefined, "GET"),
  ).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining(artifact) },
  });
  expect(
    (
      await request(
        f.owner,
        `/artifacts/${artifact}`,
        { title: "Rejected", version: edited.data.version },
        "PATCH",
      )
    ).status,
  ).toBe(409);
  expect(
    db.prepare("SELECT title,version FROM artifacts WHERE id=?").get(artifact),
  ).toEqual({ title: "Edited", version: edited.data.version });
});

it("validates continuation messages before creating a conversation and preserves historical metadata", async () => {
  const f = fixture(),
    conversation = id(),
    message = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Original',?)",
  ).run(conversation, f.owner, f.manager.id, now());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES(?,?,?,'assistant','Body',?,?)",
  ).run(message, f.owner, conversation, '{"historicalLabel":"kept"}', now());
  const body = { agentId: f.member.id, messageIds: [message] };
  expect(
    (await request("foreign", `/conversations/${conversation}/continue`, body))
      .status,
  ).toBe(404);
  const copied = await request(
    f.owner,
    `/conversations/${conversation}/continue`,
    body,
  );
  expect(copied.status).toBe(200);
  const row = db
    .prepare("SELECT metadata FROM messages WHERE conversation_id=?")
    .get(copied.data.id) as { metadata: string };
  expect(JSON.parse(row.metadata)).toMatchObject({
    sourceMessage: message,
    original: { historicalLabel: "kept" },
  });
  const before = db.prepare("SELECT count(*) n FROM conversations").get();
  db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(
    '{"reviewId":null}',
    message,
  );
  expect(
    await request(f.owner, `/conversations/${conversation}/continue`, body),
  ).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining(message) },
  });
  expect(db.prepare("SELECT count(*) n FROM conversations").get()).toEqual(
    before,
  );
});

it("cancels import rows with damaged display and execution fields without enabling a restart", async () => {
  const owner = id(),
    job = id();
  db.prepare(
    "INSERT INTO imports(id,owner_id,provider,digest,status,created_at) VALUES(?,?,'openai',?,'queued',?)",
  ).run(job, owner, id(), now());
  const run = enqueue(owner, "Import", id(), {
    kind: "import",
    payload: { importId: job },
  });
  const payload = JSON.stringify({ importId: job, reviewId: null });
  db.prepare("UPDATE runs SET payload=? WHERE id=?").run(payload, run.id);
  db.prepare("UPDATE imports SET created_at='invalid-time' WHERE id=?").run(
    job,
  );
  expect((await request("foreign", `/imports/${job}/cancel`, {})).status).toBe(
    404,
  );
  expect((await request(owner, `/imports/${job}/start`, {})).status).toBe(409);
  expect((await request(owner, `/imports/${job}/cancel`, {})).status).toBe(200);
  expect(
    db.prepare("SELECT state,payload FROM runs WHERE id=?").get(run.id),
  ).toEqual({ state: "cancelled", payload });
  expect(
    db.prepare("SELECT status,created_at FROM imports WHERE id=?").get(job),
  ).toEqual({ status: "cancelled", created_at: "invalid-time" });
});

it("rejects damaged folders before renaming and keeps owner denial intact", async () => {
  const f = fixture();
  db.prepare("UPDATE folders SET created_at='invalid-time' WHERE id=?").run(
    f.folder,
  );
  const body = { name: "Rejected" };
  expect(
    (await request("foreign", `/folders/${f.folder}`, body, "PATCH")).status,
  ).toBe(404);
  expect(
    await request(f.owner, `/folders/${f.folder}`, body, "PATCH"),
  ).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining(f.folder) },
  });
  expect(
    db.prepare("SELECT name FROM folders WHERE id=?").get(f.folder),
  ).toEqual({ name: "Fixture" });
});

it("rejects damaged embedding connections before persisting preferences", async () => {
  const f = fixture();
  db.prepare("UPDATE connections SET models=? WHERE id=?").run(
    '[{"id":"fixture","name":42}]',
    f.connection,
  );
  const body = { embeddingEnabled: true, connectionId: f.connection };
  expect((await request("foreign", "/preferences", body)).status).toBe(404);
  expect(await request(f.owner, "/preferences", body)).toMatchObject({
    status: 409,
    data: { error: expect.stringContaining(f.connection) },
  });
  expect(
    db.prepare("SELECT 1 FROM preferences WHERE owner_id=?").get(f.owner),
  ).toBeUndefined();
});

it("renames a healthy descendant of a damaged folder while retaining reparent cycle checks", async () => {
  const f = fixture(),
    child = id(),
    grandchild = id();
  const insert = db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,parent_id,created_at) VALUES(?,?,'project',?,?,?)",
  );
  insert.run(child, f.owner, "Child", f.folder, now());
  insert.run(grandchild, f.owner, "Grandchild", child, now());
  db.prepare("UPDATE folders SET created_at='invalid-time' WHERE id=?").run(
    f.folder,
  );
  expect(
    (await request(f.owner, `/folders/${child}`, { name: "Renamed" }, "PATCH"))
      .status,
  ).toBe(200);
  expect(
    db.prepare("SELECT name,parent_id FROM folders WHERE id=?").get(child),
  ).toEqual({ name: "Renamed", parent_id: f.folder });
  // FolderForm sends the unchanged parent explicitly on every edit.
  expect(
    (
      await request(
        f.owner,
        `/folders/${child}`,
        { name: "Form rename", parentId: f.folder },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        f.owner,
        `/folders/${child}`,
        { parentId: grandchild },
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        f.owner,
        `/folders/${child}`,
        { parentId: fixture().folder },
        "PATCH",
      )
    ).status,
  ).toBe(404);
  expect(
    (await request(f.owner, `/folders/${child}`, { parentId: null }, "PATCH"))
      .status,
  ).toBe(200);
  expect(
    db.prepare("SELECT parent_id FROM folders WHERE id=?").get(child),
  ).toEqual({ parent_id: null });
});
