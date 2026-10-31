import { afterAll, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { workspaceApi } from "../src/shared/workspace-api";
import {
  feedCategories,
  type FeedCategory,
} from "../src/shared/feed-categories";

vi.mock("../src/server/local-embeddings.js", () => ({
  localModel: "fixture-search",
  localEmbeddings: async (texts: string[]) => texts.map(() => [1, 0]),
}));
const directory = mkdtempSync(join(tmpdir(), "loop55-search-categories-"));
process.env.LOOP55_DATA_DIR = directory;
process.env.LOOP55_PROFILE = "server";
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { workspace } = await import("../src/server/workspace-routes");
const { ownedRun } = await import("../src/server/domain");
const { publishReply, setReplyState } =
  await import("../src/server/steering-replies");
const { recordConversationUpdate } =
  await import("../src/server/conversation-updates");
const { saveArtifact } = await import("../src/server/artifacts");
const { indexPending, searchStatus } = await import("../src/server/search");
const { feed, setDoneCardHidden } = await import("../src/server/mobile-return");
const app = express();
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", workspace);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 400).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let clock = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => clock);
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
async function request(
  owner: string,
  filters: Record<string, string> = {},
  q = "categoryneedle",
) {
  const response = await fetch(
    `${origin}/api/search?${new URLSearchParams({ q, ...filters })}`,
    {
      headers: { "x-owner": owner },
    },
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return workspaceApi.search.response.parse(body);
}
const ids = (result: Awaited<ReturnType<typeof request>>) =>
  result.items.map((item) => item.id).sort();
const messageId = (message: string) => `message:${message}`;
function fixture() {
  const owner = id(),
    agent = id(),
    connection = id(),
    folder = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture','','connected','[]',?)",
  ).run(connection, owner, now());
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,created_at) VALUES(?,?,?,?,'openai',?,'fixture','',?)",
  ).run(agent, owner, agent, agent, connection, now());
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Search project',?)",
  ).run(folder, owner, now());
  return { owner, agent, connection, folder };
}
function task(
  f: ReturnType<typeof fixture>,
  state: string,
  conversation = id(),
) {
  const run = id(),
    prompt = id(),
    answer = id();
  const at = ++clock;
  db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Search category thread',?,?)",
    ).run(conversation, f.owner, f.agent, f.folder, at);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,worker_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      run,
      f.owner,
      f.agent,
      conversation,
      `categoryneedle ${state} prompt`,
      state,
      run,
      JSON.stringify({
        agentId: f.agent,
        connectionId: f.connection,
        provider: "openai",
        model: "fixture",
        folderId: f.folder,
      }),
      state === "running" ? "fixture" : null,
      at,
      at,
    );
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user',?,?)",
    ).run(
      prompt,
      f.owner,
      conversation,
      run,
      `categoryneedle ${state} prompt`,
      at,
    );
    if (state === "completed")
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','categoryneedle finished answer',?)",
      ).run(answer, f.owner, conversation, run, at + 1);
  })();
  return { run, prompt, answer, conversation, at };
}
function reply(f: ReturnType<typeof fixture>, t: ReturnType<typeof task>) {
  const steering = id();
  db.prepare(
    "INSERT INTO run_steering(id,owner_id,run_id,message_id,idempotency_key,request,state,created_at) VALUES(?,?,?,?,?,'{}','delivered',?)",
  ).run(steering, f.owner, t.run, t.prompt, steering, now());
  return publishReply(ownedRun(t.run, f.owner), id(), {
    replyTo: t.prompt,
    body: "categoryneedle published reply",
  }).messageId;
}

it("filters the production search route by Feed categories and each document's run", async () => {
  const f = fixture();
  const done = task(f, "completed");
  const working = task(f, "running", done.conversation);
  const queued = task(f, "queued", done.conversation);
  const waiting = task(f, "running");
  db.prepare("UPDATE runs SET worker_id=NULL WHERE id=?").run(waiting.run);
  const paused = task(f, "paused");
  const idle = task(f, "cancelled");
  const published = reply(f, working);
  const imported = id(),
    importedConversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Imported thread',?)",
  ).run(importedConversation, f.owner, now());
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'assistant','categoryneedle imported answer',?)",
  ).run(imported, f.owner, importedConversation, now());
  const standalone = saveArtifact(f.owner, {
    title: "categoryneedle standalone",
    content: "Outside a thread",
  });
  recordConversationUpdate(ownedRun(working.run, f.owner), "progress", {
    content: "categoryneedle ordinary progress",
  });
  const expected: Record<FeedCategory, string[]> = {
    done: [done.prompt, done.answer, idle.prompt, imported],
    working: [working.prompt, waiting.prompt],
    queued: [queued.prompt],
    replies: [published],
    threads: [
      done.prompt,
      done.answer,
      working.prompt,
      queued.prompt,
      waiting.prompt,
      paused.prompt,
      idle.prompt,
      imported,
      published,
    ],
  };
  for (const { id: category } of feedCategories) {
    const result = await request(f.owner, { category });
    expect(ids(result), category).toEqual(
      expected[category].map(messageId).sort(),
    );
    expect(result.next).toBeNull();
  }
  expect(
    feed(f.owner, { filter: "working" })
      .items.map((item) => item.conversation_id)
      .sort(),
  ).toEqual([working.conversation, waiting.conversation].sort());
  expect(ids(await request(f.owner))).toContain(`artifact:${standalone}`);
  expect(
    (await request("another-owner", { category: "threads" })).items,
  ).toEqual([]);

  // Use the real indexing worker with fixture embeddings, then search a word
  // absent from every document so only semantic retrieval can produce hits.
  db.prepare("INSERT INTO preferences VALUES(?,NULL,'fixture-search',1)").run(
    f.owner,
  );
  for (let i = 0; i < 5 && searchStatus(f.owner).pending; i++) {
    clock += 6000;
    await indexPending();
  }
  expect(searchStatus(f.owner).pending).toBe(0);
  for (const { id: category } of feedCategories) {
    const result = await request(f.owner, { category }, "semantic-only");
    expect(result.mode).toBe("hybrid");
    expect(ids(result), category).toEqual(
      expected[category].map(messageId).sort(),
    );
  }
});

it("combines categories with project, agent, type and date filters without crossing owners", async () => {
  const f = fixture(),
    other = fixture();
  const done = task(f, "completed");
  task(other, "completed");
  const result = saveArtifact(f.owner, {
    title: "categoryneedle result",
    content: "categoryneedle finished answer",
    agent: f.agent,
    conversation: done.conversation,
    run: done.run,
    folder: f.folder,
    metadata: { messageId: done.answer },
  });
  const filters = {
    category: "done",
    project: f.folder,
    agent: f.agent,
    kind: "markdown",
    from: String(done.at),
    to: String(now() + 100),
  };
  expect(ids(await request(f.owner, filters))).toEqual([`artifact:${result}`]);
  expect(
    (await request(f.owner, { ...filters, agent: other.agent })).items,
  ).toEqual([]);
  expect(
    (await request(f.owner, { ...filters, from: String(now() + 1000) })).items,
  ).toEqual([]);
  expect(
    (await request(other.owner, { category: "done", agent: f.agent })).items,
  ).toEqual([]);
  // Messages use their own run's project even after the thread is moved.
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','New project',?)",
  ).run(id(), f.owner, now());
  const newFolder = db
    .prepare("SELECT id FROM folders WHERE owner_id=? AND name='New project'")
    .get(f.owner) as { id: string };
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
    newFolder.id,
    done.conversation,
  );
  expect(
    ids(
      await request(f.owner, {
        category: "done",
        project: f.folder,
        kind: "message",
      }),
    ),
  ).toEqual([done.prompt, done.answer].map(messageId).sort());
  expect(
    (await request(f.owner, { category: "done", project: newFolder.id })).items,
  ).toEqual([]);
});

it("tracks dismissal, snoozing and reply archival without losing unrestricted history", async () => {
  const f = fixture(),
    done = task(f, "completed"),
    working = task(f, "running");
  const published = reply(f, working);
  setDoneCardHidden(f.owner, done.conversation, {
    hidden: true,
    cardKey: `run:${done.run}`,
  });
  expect((await request(f.owner, { category: "done" })).items).toEqual([]);
  expect(ids(await request(f.owner))).toContain(messageId(done.answer));
  db.prepare(
    "INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,created_at) VALUES(?,?,'conversation',?,'time',?,?)",
  ).run(id(), f.owner, done.conversation, now() + 100000, now());
  expect(ids(await request(f.owner, { category: "threads" }))).not.toContain(
    messageId(done.answer),
  );
  setReplyState(f.owner, published, { archived: true });
  expect((await request(f.owner, { category: "replies" })).items).toEqual([]);
  expect(ids(await request(f.owner))).toContain(messageId(published));
  setReplyState(f.owner, published, { archived: false });
  expect(
    ids(await request(f.owner, { category: "replies", project: f.folder })),
  ).toEqual([messageId(published)]);
});

it("filters before pagination and rejects unknown categories", async () => {
  const f = fixture();
  const queued = db.transaction(() =>
    Array.from({ length: 35 }, () => task(f, "queued")),
  )();
  db.transaction(() => {
    for (let i = 0; i < 35; i++) task(f, "completed");
  })();
  const first = await request(f.owner, { category: "queued" });
  expect(first.items).toHaveLength(30);
  expect(first.next).toBe(30);
  const second = await request(f.owner, {
    category: "queued",
    before: String(first.next),
  });
  expect(second.items).toHaveLength(5);
  expect(second.next).toBeNull();
  expect([...ids(first), ...ids(second)].sort()).toEqual(
    queued.map((t) => messageId(t.prompt)).sort(),
  );
  const invalid = await fetch(
    `${origin}/api/search?q=categoryneedle&category=unknown`,
    { headers: { "x-owner": f.owner } },
  );
  expect(invalid.status).toBe(400);
});
