import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
const dir = mkdtempSync(join(tmpdir(), "loop-feed-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { saveArtifact } = await import("../src/server/artifacts");
const { feedRevision, feedUpdates } = await import("../src/server/feed");
const { core } = await import("../src/server/core-routes");
const { enqueue } = await import("../src/server/queue");
const app = express();
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", core);
app.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e.status || 500).json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const get = async (path: string, owner: string) => {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api${path}`,
    { headers: { "x-owner": owner } },
  );
  return { status: response.status, ...(await response.json()) };
};
const cursor = (artifact: string) =>
  (
    db
      .prepare("SELECT rowid cursor FROM artifacts WHERE id=?")
      .get(artifact) as any
  ).cursor as number;
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("returns only changed visible cards and removal tombstones, scoped to their owner", () => {
  const owner = "changes",
    keys = Array.from({ length: 100 }, (_, i) =>
      saveArtifact(owner, { title: String(i), content: "original" }),
    );
  const after = feedRevision(owner),
    through = cursor(keys[20]);
  db.prepare(
    "UPDATE artifacts SET content='older edit',updated_at=1 WHERE id=?",
  ).run(keys[25]);
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(keys[30]);
  db.prepare("DELETE FROM artifacts WHERE id=?").run(keys[31]);
  db.prepare("UPDATE artifacts SET content='outside window' WHERE id=?").run(
    keys[5],
  );
  const newest = saveArtifact(owner, {
    title: "New",
    content: "new output",
    metadata: {
      appResource: { html: "large private resource" },
      toolResult: "large payload",
    },
  });
  const stranger = saveArtifact("stranger", {
    title: "Private",
    content: "not for this owner",
  });
  const changes = feedUpdates(owner, { after, through });
  expect(changes.items.map((i) => i.id)).toEqual([keys[25], newest]);
  expect(changes.items[0].content).toBe("older edit");
  expect(changes.removed).toEqual([keys[30], keys[31]]);
  expect(changes.more).toBe(false);
  expect(JSON.parse(changes.items[1].metadata)).not.toHaveProperty(
    "toolResult",
  );
  expect(JSON.parse(changes.items[1].metadata).appResource).not.toHaveProperty(
    "html",
  );
  expect(
    feedUpdates("stranger", { after: 0, through: 0 }).items.map((i) => i.id),
  ).toEqual([stranger]);
  expect(
    feedUpdates(owner, { after: changes.revision, through }).items,
  ).toEqual([]);
});

it("bounds batches at 200 and never skips repeated edits while a backlog is drained", () => {
  const owner = "backlog",
    keys = Array.from({ length: 450 }, () =>
      saveArtifact(owner, { title: "Card", content: "original" }),
    );
  const first = feedUpdates(owner, { after: 0, through: 0 });
  expect(first.items).toHaveLength(200);
  expect(first.more).toBe(true);
  for (const content of ["second", "third", "latest"])
    db.prepare("UPDATE artifacts SET content=?,updated_at=0 WHERE id=?").run(
      content,
      keys[0],
    );
  const second = feedUpdates(owner, { after: first.revision, through: 0 });
  const third = feedUpdates(owner, { after: second.revision, through: 0 });
  expect(second.items).toHaveLength(200);
  expect(third.items).toHaveLength(51);
  expect(third.more).toBe(false);
  const merged = new Map(
    [...first.items, ...second.items, ...third.items].map((i) => [i.id, i]),
  );
  expect(merged.size).toBe(450);
  expect(merged.get(keys[0]).content).toBe("latest");
  expect(
    db
      .prepare("SELECT count(*) n FROM feed_revisions WHERE object_id=?")
      .get(keys[0]),
  ).toEqual({ n: 1 });
});

it("reconciles file filters and agent labels and includes prompt changes", () => {
  const owner = "filters",
    agent = id();
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'openai','fixture',?)",
  ).run(agent, owner, "Before", agent, now());
  const artifact = saveArtifact(owner, {
    title: "Chart",
    kind: "chart",
    content: "data",
    agent,
  });
  const conversation = id(),
    message = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Chat',?)",
  ).run(conversation, owner, agent, now());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'user','Question',?)",
  ).run(message, owner, conversation, now());
  const after = feedRevision(owner);
  db.prepare("UPDATE agents SET name='After' WHERE id=?").run(agent);
  expect(
    feedUpdates(owner, { after, through: 0, agent, view: "files" }).items[0]
      .name,
  ).toBe("After");
  expect(
    feedUpdates(owner, { after, through: 0, agent, view: "prompts" }).items[0],
  ).toMatchObject({ id: message, name: "After", content: "Question" });
  db.prepare("UPDATE artifacts SET kind='markdown' WHERE id=?").run(artifact);
  expect(
    feedUpdates(owner, { after, through: 0, view: "files" }).removed,
  ).toEqual([artifact]);
  expect(
    feedUpdates(owner, { after, through: 0, agent: "other" }).removed,
  ).toEqual([artifact]);
  db.prepare("DELETE FROM messages WHERE id=?").run(message);
  expect(
    feedUpdates(owner, { after, through: 0, view: "prompts" }).removed,
  ).toEqual([message]);
});

it("keeps project feed updates scoped when outputs are filed or moved", () => {
  const owner = "project-feed",
    project = id(),
    other = id();
  for (const folder of [project, other])
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project',?,?)",
    ).run(folder, owner, folder, now());
  const filed = saveArtifact(owner, {
    title: "Filed",
    content: "A",
    folder: project,
  });
  const elsewhere = saveArtifact(owner, {
    title: "Elsewhere",
    content: "B",
    folder: other,
  });
  const first = feedUpdates(owner, { after: 0, through: 0, folder: project });
  expect(first.items.map((item) => item.id)).toEqual([filed]);
  expect(first.removed).toContain(elsewhere);
  db.prepare("UPDATE artifacts SET folder_id=?,updated_at=? WHERE id=?").run(
    other,
    now(),
    filed,
  );
  expect(
    feedUpdates(owner, { after: first.revision, through: 0, folder: project })
      .removed,
  ).toContain(filed);
});

it("includes nested project folders and excludes another owner's folder tree", async () => {
  const { projectFolders } = await import("../src/server/feed");
  const owner = "nested-project-feed",
    project = id(),
    child = id(),
    foreign = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Parent',?)",
  ).run(project, owner, now());
  for (const [folder, who] of [
    [child, owner],
    [foreign, "other-owner"],
  ])
    db.prepare(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'folder','Child',?)",
    ).run(folder, who, project, now());
  const artifact = saveArtifact(owner, {
    title: "Nested result",
    content: "Finished",
    folder: child,
  });
  expect(projectFolders(owner, project)).toEqual([project, child]);
  expect(
    feedUpdates(owner, { after: 0, through: 0, folder: project }).items.map(
      (item) => item.id,
    ),
  ).toContain(artifact);
  expect(projectFolders("other-owner", project)).toEqual([]);
  const outside = saveArtifact(owner, {
    title: "Elsewhere",
    content: "Other project",
  });
  const privateArtifact = saveArtifact("other-owner", {
    title: "Private",
    content: "Other owner",
    folder: foreign,
  });
  expect(
    (await get(`/feed?folder=${project}`, owner)).items.map(
      (item: any) => item.id,
    ),
  ).toEqual([artifact]);
  expect((await get(`/feed?folder=${project}`, "other-owner")).status).toBe(
    404,
  );
  expect((await get(`/feed?folder=${foreign}`, owner)).status).toBe(404);
  const conversation = id(),
    agent = id();
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'openai','fixture',?)",
  ).run(agent, owner, agent, agent, now());
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Project chat',?)",
  ).run(conversation, owner, agent, now());
  const prompts = [child, project, null].map((folderId) => {
    const run = enqueue(owner, "Question", id(), {
      agent,
      conversation,
      payload: { folderId },
    });
    const message = id();
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user','Question',?)",
    ).run(message, owner, conversation, run.id, now());
    return message;
  });
  expect(
    (await get(`/feed?view=prompts&folder=${project}`, owner)).items.map(
      (item: any) => item.id,
    ),
  ).toEqual([prompts[1], prompts[0]]);
  expect(
    (await get(`/feed?folder=${project}`, owner)).items.map(
      (item: any) => item.id,
    ),
  ).not.toEqual(expect.arrayContaining([outside, privateArtifact]));
});
