import { afterAll, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import express from "express";
import {
  CardSchema,
  CardPageSchema,
  CardChangesSchema,
  type CardEntry,
  type CardSelection,
} from "../src/shared/cards";
const dir = mkdtempSync(join(tmpdir(), "loop-cards-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db");
// Observe executions so cached lazy statements participate in the same probes.
const prepare = db.prepare.bind(db);
let observeAll:
  | ((sql: string, args: unknown[], read: () => unknown[]) => unknown[])
  | undefined;
db.prepare = ((sql: string) => {
  const statement = prepare(sql);
  if (
    sql.startsWith("WITH card_projects(") ||
    sql.includes("WITH RECURSIVE scope(id)")
  ) {
    const all = statement.all.bind(statement);
    statement.all = (...args: unknown[]) =>
      observeAll ? observeAll(sql, args, () => all(...args)) : all(...args);
  }
  return statement;
}) as typeof db.prepare;
const { listCards, cardDetail, cardChanges } =
  await import("../src/server/cards");
const { setSaved, setSavedLabel, listSaved } =
  await import("../src/server/mobile-return");
const { saveArtifact } = await import("../src/server/artifacts");
const { personalHistory } = await import("../src/server/personal-history");
const { ensureWorkspaceProject } =
  await import("../src/server/workspace-project");
const { cards } = await import("../src/server/card-routes");
const { errorHandler } = await import("../src/server/error-handler");
const app = express();
app.use((_req, res, next) => {
  res.locals.owner = "http";
  next();
});
app.use("/api", cards);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/cards`;
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function setup(owner: string) {
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'openai','fixture',1)",
  ).run(owner, owner, owner, owner);
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Project',1)",
  ).run(owner, owner);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Thread',?,1)",
  ).run(owner, owner, owner, owner);
}
function message(
  owner: string,
  id: string,
  role = "user",
  meta: object = { personal: true, attachments: [] },
  at = 10,
) {
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'Prompt','completed',?,?,?)",
  ).run(id, owner, owner, owner, id, at, at);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(id, owner, owner, id, role, "Body " + id, JSON.stringify(meta), at);
  return id;
}
function result(
  owner: string,
  data: Partial<Parameters<typeof saveArtifact>[1]> = {},
) {
  return saveArtifact(owner, {
    title: "Answer",
    content: "Full answer",
    agent: owner,
    conversation: owner,
    folder: owner,
    ...data,
    role: "answer",
  });
}
function all(owner: string, options: CardSelection, limit = 3) {
  const first = listCards(owner, { ...options, limit });
  const items = new Map(first.items.map((i) => [i.card.id, i]));
  let next = first.next;
  while (next) {
    const page = listCards(owner, { ...options, before: next, limit });
    for (const item of page.items) items.set(item.card.id, item);
    next = page.next;
  }
  return { items, revision: first.revision };
}
function reconcile(
  owner: string,
  options: CardSelection,
  cache: { items: Map<string, CardEntry>; revision: string },
) {
  for (let n = 0; n < 100; n++) {
    const delta = cardChanges(owner, { ...options, after: cache.revision });
    CardChangesSchema.parse(delta);
    for (const id of delta.removed) cache.items.delete(id);
    for (const item of delta.items) cache.items.set(item.card.id, item);
    cache.revision = delta.revision;
    if (!delta.more) return;
  }
  throw new Error("Changes made no progress");
}
function expectCurrent(
  owner: string,
  view: CardSelection,
  cache: ReturnType<typeof all>,
) {
  reconcile(owner, view, cache);
  const sort = (items: Map<string, CardEntry>) =>
    [...items.values()].sort((a, b) => a.card.id.localeCompare(b.card.id));
  expect(sort(cache.items)).toEqual(sort(all(owner, view).items));
}

it("shares full cards across Results, Saved and detail without leaking internal metadata", () => {
  setup("contract");
  const id = result("contract", {
    content: "# Long answer\n" + "Complete text. ".repeat(700),
    metadata: {
      appResource: { html: "private executable" },
      toolResult: { secret: "internal" },
      connectionId: "private connection",
    },
  });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  setSavedLabel("contract", { key: "a:" + id, label: "Keep" });
  const results = CardPageSchema.parse(
    listCards("contract", { view: "results" }),
  );
  const saved = listCards("contract", { view: "saved" });
  const detail = CardSchema.parse(cardDetail("contract", "a:" + id));
  expect(results.items[0].card).toEqual(saved.items[0].card);
  expect(detail).toEqual(results.items[0].card);
  expect(detail.content.length).toBeGreaterThan(9000);
  expect(JSON.stringify(detail)).not.toMatch(
    /private executable|internal|private connection|metadata/,
  );
  expect(saved.items[0].saved?.label).toBe("Keep");
  expect(results.items[0].saved).toBeNull();
  db.prepare("UPDATE artifacts SET feed_hidden=1 WHERE id=?").run(id);
  expect(listCards("contract", {}).items).toHaveLength(0);
  expect(listCards("contract", { view: "saved" }).items).toHaveLength(1);
  expect(cardDetail("contract", "a:" + id, ["read"])).toEqual({
    ...detail,
    hidden: true,
  });
  const file = result("contract", {
    kind: "file",
    metadata: { uploaded: true, name: "notes.txt" },
  });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(file);
  expect(listCards("contract", {}).items).toHaveLength(0);
  expect(cardDetail("contract", "a:" + file)).toMatchObject({
    type: "result",
    kind: "file",
  });
});

it("uses personal-history provenance and keeps truthful attribution and historical message bookmarks", () => {
  setup("personal");
  for (const [id, meta] of [
    ["personal-explicit", { personal: true }],
    ["personal-unattributed", { attachments: [] }],
    ["personal-import", { backend: "native", attachments: [] }],
    ["personal-forward", { sourceMessage: "x", attachments: [] }],
    ["personal-unlinked", {}],
    ["personal-delegated", { attachments: [] }],
  ] as const)
    message("personal", id, "user", meta);
  db.prepare(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments) VALUES('personal-explicit','d','personal-delegated','{}')",
  ).run();
  const ids = listCards("personal", { view: "sent" })
    .items.map((i) => i.card.source.message_id)
    .sort();
  expect(ids).toEqual(
    personalHistory("personal")
      .items.map((i) => i.id)
      .sort(),
  );
  expect(ids).toEqual(["personal-explicit"]);
  setSaved("personal", "personal-explicit", true);
  const sent = cardDetail("personal", "m:personal-explicit");
  expect(sent).toMatchObject({
    author: { kind: "owner", name: null },
    recipient: { id: "personal" },
    updated_at: null,
  });
  expect(listCards("personal", { view: "saved" }).items[0].card).toEqual(sent);
  message("personal", "personal-system", "system", {});
  setSaved("personal", "personal-system", true);
  expect(cardDetail("personal", "m:personal-system").author.kind).toBe(
    "system",
  );
  expect(cardDetail("personal", "m:personal-system").recipient).toBeNull();
  message("personal", "personal-answer", "assistant", {});
  setSaved("personal", "personal-answer", true);
  expect(cardDetail("personal", "m:personal-answer")).toMatchObject({
    author: { kind: "agent", id: "personal" },
    recipient: null,
  });
  const received = all("personal", { view: "saved", agent: "personal" });
  expect([...received.items.keys()]).toEqual(["m:personal-explicit"]);
  db.prepare(
    "UPDATE messages SET role='assistant' WHERE id='personal-explicit'",
  ).run();
  expectCurrent("personal", { view: "saved", agent: "personal" }, received);
  expect(received.items.size).toBe(0);
  db.prepare(
    "UPDATE messages SET role='user' WHERE id='personal-explicit'",
  ).run();
  setSavedLabel("personal", {
    key: "m:personal-answer",
    label: "Earlier bookmark",
  });
  const id = result("personal", { metadata: { messageId: "personal-answer" } });
  expect(
    listCards("personal", { view: "saved" }).items.some(
      (i) => i.card.id === "m:personal-answer",
    ),
  ).toBe(true);
  expect(cardDetail("personal", "a:" + id).source.message_id).toBe(
    "personal-answer",
  );
  setSaved("personal", "personal-answer", true);
  expect(
    listCards("personal", { view: "saved" }).items.map((i) => i.card.id),
  ).toContain("a:" + id);
  expect(
    listCards("personal", { view: "saved" }).items.map((i) => i.card.id),
  ).not.toContain("m:personal-answer");
  setSaved("personal", "personal-answer", false);
  expect(cardDetail("personal", "a:" + id).saved).toBe(false);
});

it("invalidates both bookmark identities when a relationship changes", () => {
  setup("bookmark-edge");
  message("bookmark-edge", "bookmark-before", "assistant", {});
  message("bookmark-edge", "bookmark-after", "assistant", {});
  setSaved("bookmark-edge", "bookmark-before", true);
  const cache = all("bookmark-edge", { view: "saved" });
  db.prepare(
    "UPDATE message_bookmarks SET message_id='bookmark-after' WHERE message_id='bookmark-before'",
  ).run();
  expectCurrent("bookmark-edge", { view: "saved" }, cache);
  expect([...cache.items.keys()]).toEqual(["m:bookmark-after"]);
  db.prepare(
    "UPDATE message_bookmarks SET owner_id='foreign' WHERE message_id='bookmark-after'",
  ).run();
  expectCurrent("bookmark-edge", { view: "saved" }, cache);
  expect(cache.items.size).toBe(0);
});

it("keeps completed historical results and excludes partial, running, failed, tool and incorrect native checkpoints", () => {
  setup("eligibility");
  const first = result("eligibility"),
    second = result("eligibility");
  result("eligibility", { metadata: { partial: true } });
  result("eligibility", { metadata: { tool: "fixture" } });
  for (const state of ["running", "failed", "completed"]) {
    const run = message("eligibility", "eligibility-" + state);
    db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, run);
    const id = result("eligibility", { run, metadata: { native: true } });
    if (state === "completed") {
      db.prepare(
        "INSERT INTO agent_checkpoints(run_id,message_id,history,stage,artifact_id) VALUES(?,?,'[]','done',?)",
      ).run(run, run, id);
    }
  }
  const cards = listCards("eligibility", {}).items;
  expect(cards).toHaveLength(3);
  expect(cards.map((i) => i.card.id)).toEqual(
    expect.arrayContaining(["a:" + first, "a:" + second]),
  );
});

it("reconciles writes during pagination, more than 200 revisions, selection exits and tied save times", () => {
  setup("sync");
  const keys = Array.from({ length: 212 }, () => result("sync"));
  const page = listCards("sync", { limit: 2 });
  const cache = {
    items: new Map(page.items.map((i) => [i.card.id, i])),
    revision: page.revision,
  };
  db.prepare(
    "UPDATE artifacts SET content='Changed' WHERE owner_id='sync'",
  ).run();
  db.prepare("UPDATE artifacts SET feed_hidden=1 WHERE id=?").run(keys[0]);
  result("sync", { content: "Arrived during pagination" });
  let next = page.next;
  while (next) {
    const older = listCards("sync", { before: next, limit: 19 });
    for (const i of older.items) cache.items.set(i.card.id, i);
    next = older.next;
  }
  expectCurrent("sync", { view: "results" }, cache);
  const saved = all("sync", { view: "saved" });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE owner_id='sync'").run();
  db.prepare(
    "UPDATE artifact_bookmarks SET saved_at=100 WHERE artifact_id IN (SELECT id FROM artifacts WHERE owner_id='sync')",
  ).run();
  message("sync", "sync-saved", "assistant", {});
  setSaved("sync", "sync-saved", true);
  db.prepare(
    "UPDATE message_bookmarks SET created_at=100 WHERE message_id='sync-saved'",
  ).run();
  expectCurrent("sync", { view: "saved" }, saved);
  setSavedLabel("sync", { key: "m:sync-saved", label: "Chosen" });
  db.prepare("UPDATE artifacts SET pinned=0 WHERE id=?").run(keys[1]);
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(keys[2]);
  db.prepare(
    "UPDATE messages SET content='Edited bookmark' WHERE id='sync-saved'",
  ).run();
  expectCurrent("sync", { view: "saved" }, saved);
  db.prepare("DELETE FROM messages WHERE id='sync-saved'").run();
  expectCurrent("sync", { view: "saved" }, saved);
  const window = cardChanges("sync", {
    after: page.revision,
    through: page.items.at(-1)!.order[0],
  });
  expect(
    window.items.every((i) => i.order[0] >= page.items.at(-1)!.order[0]),
  ).toBe(true);
});

it("limits Results change bodies without reporting eligible older cards as removed", () => {
  setup("bounded");
  const edited = result("bounded"),
    hidden = result("bounded"),
    deleted = result("bounded");
  result("bounded");
  const first = listCards("bounded", { limit: 1 });
  db.prepare("UPDATE artifacts SET content='Older edit' WHERE id=?").run(
    edited,
  );
  db.prepare("UPDATE artifacts SET feed_hidden=1 WHERE id=?").run(hidden);
  db.prepare("DELETE FROM artifacts WHERE id=?").run(deleted);
  const window = cardChanges("bounded", {
    after: first.revision,
    through: first.items[0].order[0],
  });
  expect(window.items).toEqual([]);
  expect(window.removed.sort()).toEqual(["a:" + hidden, "a:" + deleted].sort());
  const full = cardChanges("bounded", { after: first.revision });
  expect(full.items.map((i) => i.card.id)).toEqual(["a:" + edited]);
  expect(full.items[0].card.content).toBe("Older edit");
});

it("uses ID lookups for actual detail and change queries and skips empty candidate sets", () => {
  setup("targeted");
  const artifact = result("targeted");
  message("targeted", "targeted-message");
  setSaved("targeted", "targeted-message", true);
  const saved = listCards("targeted", { view: "saved" });
  const results = listCards("targeted", {});
  const plans: string[][] = [];
  observeAll = (sql, args, read) => {
    if (sql.startsWith("WITH card_projects("))
      plans.push(
        (
          prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as {
            detail: string;
          }[]
        ).map((row) => row.detail),
      );
    return read();
  };
  try {
    expect(cardChanges("targeted", { after: results.revision }).items).toEqual(
      [],
    );
    expect(plans).toHaveLength(0);
    cardDetail("targeted", "a:" + artifact);
    cardDetail("targeted", "m:targeted-message");
    db.prepare("UPDATE artifacts SET content='Changed' WHERE id=?").run(
      artifact,
    );
    db.prepare(
      "UPDATE messages SET content='Changed' WHERE id='targeted-message'",
    ).run();
    cardChanges("targeted", { after: results.revision });
    cardChanges("targeted", { view: "saved", after: saved.revision });
    expect(plans.length).toBeGreaterThanOrEqual(5);
    for (const plan of plans) {
      expect(
        plan.some((line) => /SEARCH [am] USING .*\bid=\?/.test(line)),
        plan.join("\n"),
      ).toBe(true);
      expect(
        plan.some((line) => /^SCAN [am]\b/.test(line)),
        plan.join("\n"),
      ).toBe(false);
    }
  } finally {
    observeAll = undefined;
  }
});

it("suppresses partial chunk revisions, then converges at terminal boundaries and across role entities", () => {
  setup("stream");
  message("stream", "stream-message", "assistant", { partial: true });
  setSaved("stream", "stream-message", true);
  const saved = all("stream", { view: "saved" });
  const revision = () =>
    (
      db
        .prepare(
          "SELECT max(revision) r FROM feed_revisions WHERE owner_id='stream'",
        )
        .get() as { r: number }
    ).r;
  const before = revision();
  for (let i = 0; i < 8; i++)
    db.prepare("UPDATE messages SET content=? WHERE id='stream-message'").run(
      "chunk " + i,
    );
  expect(revision()).toBe(before);
  db.prepare(
    "UPDATE runs SET state='interrupted' WHERE id='stream-message'",
  ).run();
  expectCurrent("stream", { view: "saved" }, saved);
  expect(saved.items.get("m:stream-message")?.card.content).toBe("chunk 7");
  db.prepare(
    "UPDATE messages SET role='user',metadata=? WHERE id='stream-message'",
  ).run(JSON.stringify({ partial: true, personal: true }));
  expectCurrent("stream", { view: "saved" }, saved);
  const sent = all("stream", { view: "sent" });
  db.prepare(
    "UPDATE messages SET role='assistant',metadata='{}',content='Final' WHERE id='stream-message'",
  ).run();
  expectCurrent("stream", { view: "sent" }, sent);
  expectCurrent("stream", { view: "saved" }, saved);
  expect(sent.items.size).toBe(0);
  expect(saved.items.get("m:stream-message")?.card.content).toBe("Final");
});

it("invalidates joined display, scope, personal provenance, canonical saves and Workspace membership", () => {
  setup("joined");
  setup("foreign");
  const id = result("joined");
  message("joined", "joined-message", "user", {
    personal: true,
    attachments: [],
  });
  setSaved("joined", "joined-message", true);
  const views = ["results", "saved", "sent"] as const;
  const caches = views.map((view) => all("joined", { view }));
  const check = () =>
    views.forEach((view, i) => expectCurrent("joined", { view }, caches[i]));
  db.prepare(
    "UPDATE agents SET name='Renamed',provider='anthropic' WHERE id='joined'",
  ).run();
  db.prepare(
    "UPDATE conversations SET title='New title' WHERE id='joined'",
  ).run();
  db.prepare(
    "UPDATE folders SET name='Renamed project' WHERE id='joined'",
  ).run();
  check();
  db.prepare(
    "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES('joined-child','joined','joined','folder','Child',1)",
  ).run();
  db.prepare("UPDATE artifacts SET folder_id='joined-child' WHERE id=?").run(
    id,
  );
  db.prepare("UPDATE runs SET payload=? WHERE id='joined-message'").run(
    JSON.stringify({ folderId: "joined-child" }),
  );
  check();
  const filtered = all("joined", { view: "sent", project: "joined" });
  const workspace = ensureWorkspaceProject("joined");
  const workspaceCache = all("joined", { view: "sent", project: workspace });
  db.prepare("UPDATE folders SET parent_id=NULL WHERE id='joined-child'").run();
  expectCurrent("joined", { view: "sent", project: "joined" }, filtered);
  expectCurrent("joined", { view: "sent", project: workspace }, workspaceCache);
  expect(filtered.items.size).toBe(0);
  expect(workspaceCache.items.size).toBe(1);
  check();
  db.prepare(
    "UPDATE messages SET metadata=json_set(metadata,'$.personal',json('false')) WHERE id='joined-message'",
  ).run();
  check();
  expect(caches[2].items.size).toBe(0);
  db.prepare(
    "UPDATE messages SET metadata=json_set(metadata,'$.personal',json('true')) WHERE id='joined-message'",
  ).run();
  check();
  const related = result("joined", {
    metadata: { messageId: "joined-message" },
  });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(related);
  check();
  db.prepare(
    "UPDATE conversations SET owner_id='foreign' WHERE id='joined'",
  ).run();
  check();
  expect(caches.every((c) => c.items.size === 0)).toBe(true);
});

it("uses authorized immutable attachment descriptions and invalidates removal of their targets", () => {
  setup("files");
  const file = result("files", {
    kind: "file",
    metadata: { upload: true, objectId: "files-object" },
  });
  db.prepare(
    "INSERT INTO objects VALUES('files-object','files','Original','text/plain',X'01',1)",
  ).run();
  const attachment = {
    id: file,
    name: "Snapshot name",
    mime: "text/plain",
    size: 1,
  };
  message("files", "files-message", "user", {
    personal: true,
    attachments: [attachment, { ...attachment, id: "someone-elses-file" }],
  });
  const cache = all("files", { view: "sent" });
  expect(cache.items.get("m:files-message")?.card.attachments).toHaveLength(1);
  db.prepare(
    "UPDATE objects SET name='Renamed mutable object' WHERE id='files-object'",
  ).run();
  expect(cardDetail("files", "m:files-message").attachments[0].name).toBe(
    "Snapshot name",
  );
  db.prepare("DELETE FROM objects WHERE id='files-object'").run();
  expectCurrent("files", { view: "sent" }, cache);
  expect(
    cache.items.get("m:files-message")?.card.attachments[0].download,
  ).toBeNull();
  db.prepare("DELETE FROM artifacts WHERE id=?").run(file);
  expectCurrent("files", { view: "sent" }, cache);
  expect(cache.items.get("m:files-message")?.card.attachments).toHaveLength(0);
});

it("reconciles search, team changes, re-saves and both owners of a transferred record", () => {
  setup("filters");
  setup("transfer");
  db.prepare(
    "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES('filters-team','filters','Team','filters',1)",
  ).run();
  const id = result("filters");
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  const selection = {
    view: "saved" as const,
    q: "chosen",
    teams: "filters-team",
  };
  const cache = all("filters", selection);
  setSavedLabel("filters", { key: "a:" + id, label: "Chosen" });
  expectCurrent("filters", selection, cache);
  expect(cache.items.size).toBe(0);
  db.prepare(
    "UPDATE conversations SET team_id='filters-team' WHERE id='filters'",
  ).run();
  expectCurrent("filters", selection, cache);
  expect(cache.items.size).toBe(1);
  db.prepare("UPDATE artifacts SET pinned=0 WHERE id=?").run(id);
  expectCurrent("filters", selection, cache);
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  expectCurrent("filters", selection, cache);
  expect(cache.items.size).toBe(1);
  const oldOwner = all("filters", { view: "results" });
  const newOwner = all("transfer", { view: "results" });
  db.prepare(
    "UPDATE artifacts SET owner_id='transfer',conversation_id=NULL,agent_id=NULL,folder_id=NULL WHERE id=?",
  ).run(id);
  expectCurrent("filters", { view: "results" }, oldOwner);
  expectCurrent("transfer", { view: "results" }, newOwner);
  expect(oldOwner.items.size).toBe(0);
  expect(newOwner.items.size).toBe(1);
  expect(
    db
      .prepare(
        "SELECT count(DISTINCT owner_id) n FROM feed_revisions WHERE entity='artifact' AND object_id=?",
      )
      .get(id),
  ).toEqual({ n: 2 });
});

it("refreshes default Workspace context on creation and advances through irrelevant changes", () => {
  setup("default");
  db.prepare(
    "UPDATE conversations SET project_id=NULL WHERE id='default'",
  ).run();
  message("default", "default-message");
  const cache = all("default", { view: "sent" });
  expect(
    cache.items.get("m:default-message")?.card.context.project_id,
  ).toBeNull();
  const workspace = ensureWorkspaceProject("default");
  expectCurrent("default", { view: "sent" }, cache);
  expect(cache.items.get("m:default-message")?.card.context.project_id).toBe(
    workspace,
  );
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('default-loose','default','folder','Unfiled folder',1)",
  ).run();
  const unfiled = result("default", { folder: null });
  const loose = result("default", { folder: "default-loose" });
  const results = all("default", { view: "results" });
  db.prepare("UPDATE folders SET name='Renamed Workspace' WHERE id=?").run(
    workspace,
  );
  expectCurrent("default", { view: "sent" }, cache);
  expectCurrent("default", { view: "results" }, results);
  expect(cache.items.get("m:default-message")?.card.context.project_name).toBe(
    "Renamed Workspace",
  );
  for (const id of [unfiled, loose])
    expect(results.items.get("a:" + id)?.card.context.project_name).toBe(
      "Renamed Workspace",
    );
  for (let i = 0; i < 211; i++)
    result("default", { metadata: { partial: true } });
  expectCurrent("default", { view: "sent" }, cache);
  expect(cache.items.size).toBe(1);
  expect(
    cardChanges("default", { view: "sent", after: cache.revision }),
  ).toMatchObject({ items: [], removed: [], more: false });
});

it("preserves same-owner run associations while requiring exact provenance for Sent", () => {
  setup("association");
  message("association", "association-run");
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('association-other','association','Other thread',1)",
  ).run();
  db.prepare(
    "UPDATE runs SET conversation_id='association-other' WHERE id='association-run'",
  ).run();
  const id = result("association", { run: "association-run" });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  expect(
    listCards("association", { view: "results" }).items.map((i) => i.card.id),
  ).toContain("a:" + id);
  expect(
    listCards("association", { view: "saved" }).items.map((i) => i.card.id),
  ).toContain("a:" + id);
  expect(listCards("association", { view: "sent" }).items).toEqual([]);
});

it("indexes reverse attachment edges and uses indexed candidates in production write triggers", () => {
  setup("edges");
  const file = result("edges", { kind: "file", metadata: { upload: true } });
  message("edges", "edges-message", "user", {
    personal: true,
    attachments: [
      { id: file, name: "file", mime: "text/plain", size: 1 },
      "invalid descriptor",
      null,
    ],
  });
  const edges = () =>
    db
      .prepare(
        "SELECT target_id FROM card_attachment_refs WHERE owner_id='edges' AND entity='message' AND object_id='edges-message'",
      )
      .all();
  expect(edges()).toEqual([{ target_id: file }]);
  for (const trigger of [
    "card_artifact_insert_refs",
    "card_object_insert",
    "card_artifact_object_insert",
  ]) {
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(trigger) as { sql: string };
    const statement = sql
      .split("BEGIN\n")[1]
      .split(";")[0]
      .replaceAll("new.owner_id", "'edges'")
      .replaceAll("new.artifact_id", "'target'")
      .replaceAll("new.id", "'target'")
      .replaceAll("new.metadata", "'{}'");
    const plan = (
      db.prepare("EXPLAIN QUERY PLAN " + statement).all() as {
        detail: string;
      }[]
    )
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toMatch(/SEARCH m .*\([^)]*\bid=\?\)/);
    expect(plan).toContain("card_attachment_refs_target");
    if (trigger === "card_object_insert")
      expect(plan).toContain("card_artifact_object_link");
  }
  db.prepare("UPDATE messages SET metadata=? WHERE id='edges-message'").run(
    JSON.stringify({ personal: true, attachments: [] }),
  );
  expect(edges()).toEqual([]);
});

it("limits folder invalidations to indexed conversation and run candidates", () => {
  setup("folder-index");
  for (const trigger of [
    "card_folder_insert",
    "card_folder_leaving",
    "card_folder_entering",
    "card_folder_delete",
  ]) {
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(trigger) as { sql: string };
    const statements = sql.split("BEGIN\n")[1].split(";");
    const plan = (index: number) =>
      (
        db
          .prepare(
            "EXPLAIN QUERY PLAN " +
              statements[index]
                .replaceAll(/(?:new|old)\.owner_id/g, "'folder-index'")
                .replaceAll(/(?:new|old)\.id/g, "'folder-index'"),
          )
          .all() as { detail: string }[]
      )
        .map((r) => r.detail)
        .join("\n");
    const candidates = plan(1);
    expect(candidates).toContain("card_conversations_project");
    expect(candidates).toContain("card_runs_folder");
    expect(candidates).toContain("card_messages_conversation");
    expect(candidates).toMatch(/SEARCH mm .*\(owner_id=\? AND run_id=\?\)/);
    expect(candidates).toMatch(
      /card_runs_folder \(owner_id=\? AND <expr>=\?\)/,
    );
    expect(candidates).toMatch(/SEARCH m .*\([^)]*\bid=\?\)/);
    expect(candidates).not.toMatch(/SCAN (m|mm)\b/);
    // Ordinary folder changes never enter the broad logical Workspace update.
    for (const index of [2, 3]) {
      const steps = plan(index);
      expect(steps).toMatch(/SEARCH wp .*\((?:owner|project)_id=\?\)/);
      expect(steps.indexOf("SEARCH wp")).toBeLessThan(
        steps.search(/SEARCH [am] /),
      );
    }
  }
});

it("uses indexed source candidates throughout production card invalidation triggers", () => {
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND (name LIKE 'card_%' OR name IN ('agent_feed_update','run_feed_update'))",
    )
    .all() as { name: string; sql: string }[];
  let checked = 0;
  for (const { name, sql } of triggers) {
    for (const match of sql.matchAll(
      /INSERT INTO feed_revisions\(entity,object_id,owner_id,cursor\)\s+(SELECT[\s\S]*?);/g,
    )) {
      const statement = match[0].replaceAll(
        /\b(?:new|old)\.([a-z_]+)/g,
        (_match, column: string) =>
          column === "metadata"
            ? "'{}'"
            : column === "rowid"
              ? "1"
              : "'audit-key'",
      );
      const plan = (
        db.prepare("EXPLAIN QUERY PLAN " + statement).all() as {
          detail: string;
        }[]
      )
        .map((row) => row.detail)
        .join("\n");
      expect(plan, name).not.toMatch(/\bSCAN (?:m|a|mm|rr|cc)\b/);
      if (name === "agent_feed_update" || name === "card_agent_delete") {
        if (statement.includes("FROM messages m")) {
          expect(plan, name).toContain("card_runs_agent");
          expect(plan, name).toContain("card_conversations_agent");
        }
      }
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(50);
});

it.each(["list-out", "list-in", "changes-out", "changes-in"])(
  "reconciles an inter-process folder move during selection resolution (%s)",
  (scenario) => {
    const owner = "concurrent-" + scenario;
    setup(owner);
    const other = owner + "-other",
      child = owner + "-child";
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Other',1)",
    ).run(other, owner);
    db.prepare(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'folder','Child',1)",
    ).run(child, owner, scenario.endsWith("-out") ? owner : other);
    const id = result(owner, { folder: child });
    const selection = { view: "results" as const, project: owner };
    let cache = all(owner, selection);
    db.prepare(
      "UPDATE artifacts SET content='Changed before folder move' WHERE id=?",
    ).run(id);
    let interleaved = false;
    observeAll = (sql, _args, read) => {
      const folders = read();
      if (sql.includes("WITH RECURSIVE scope(id)")) {
        if (!interleaved) {
          interleaved = true;
          const writer = spawnSync(
            process.execPath,
            [
              "-e",
              `
              const DB=require('better-sqlite3');
              const db=new DB(process.argv[1]); db.pragma('foreign_keys=ON');
              db.prepare('UPDATE folders SET parent_id=? WHERE id=?').run(process.argv[2],process.argv[3]);
              db.close();`,
              join(dir, "loop.db"),
              scenario.endsWith("-out") ? other : owner,
              child,
            ],
            { encoding: "utf8" },
          );
          expect(writer.status, writer.stderr).toBe(0);
        }
      }
      return folders;
    };
    try {
      if (scenario.startsWith("list")) {
        const page = listCards(owner, selection);
        cache = {
          items: new Map(page.items.map((entry) => [entry.card.id, entry])),
          revision: page.revision,
        };
      } else {
        const delta = cardChanges(owner, {
          ...selection,
          after: cache.revision,
        });
        for (const key of delta.removed) cache.items.delete(key);
        for (const entry of delta.items) cache.items.set(entry.card.id, entry);
        cache.revision = delta.revision;
      }
    } finally {
      observeAll = undefined;
    }
    expect(interleaved).toBe(true);
    expectCurrent(owner, selection, cache);
    expect(cache.items.has("a:" + id)).toBe(scenario.endsWith("-in"));
  },
);

it("matches Unicode case and canonical accents in Saved and Sent search and changes", () => {
  setup("unicode");
  const resultId = result("unicode", { title: "ÉCLAIR", content: "КНИГА" });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(resultId);
  const prompt = message("unicode", "unicode-prompt");
  db.prepare("UPDATE messages SET content='ÉCLAIR КНИГА' WHERE id=?").run(
    prompt,
  );
  setSaved("unicode", prompt, true);
  for (const view of ["saved", "sent"] as const) {
    for (const q of ["éclair", "e\u0301clair", "книга"]) {
      const cache = all("unicode", { view, q });
      expect(cache.items.has("m:" + prompt)).toBe(true);
      if (view === "saved") expect(cache.items.has("a:" + resultId)).toBe(true);
      db.prepare("UPDATE messages SET content='Different body' WHERE id=?").run(
        prompt,
      );
      expectCurrent("unicode", { view, q }, cache);
      expect(cache.items.has("m:" + prompt)).toBe(false);
      db.prepare("UPDATE messages SET content='ÉCLAIR КНИГА' WHERE id=?").run(
        prompt,
      );
    }
  }
  setSavedLabel("unicode", { key: "a:" + resultId, label: "ÜBER" });
  setSavedLabel("unicode", { key: "m:" + prompt, label: "ÜBER" });
  expect(listCards("unicode", { view: "saved", q: "über" }).items).toHaveLength(
    2,
  );
  db.prepare(
    "UPDATE conversations SET title='ÅNGSTRÖM' WHERE id='unicode'",
  ).run();
  expect(
    listCards("unicode", { view: "saved", q: "ångström" }).items.map(
      (i) => i.card.id,
    ),
  ).toEqual(["m:" + prompt]);
});

it.each(["project", "folder"] as const)(
  "groups nested projects under their own identity beneath a %s",
  (kind) => {
    const owner = "nested-" + kind;
    setup(owner);
    ensureWorkspaceProject(owner);
    if (kind === "folder")
      db.prepare("UPDATE folders SET kind='folder' WHERE id=?").run(owner);
    const project = owner + "-project",
      child = owner + "-child";
    db.prepare(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'project','Nested project',1)",
    ).run(project, owner, owner);
    db.prepare(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'folder','Child',1)",
    ).run(child, owner, project);
    const id = result(owner, { folder: child });
    const prompt = message(owner, owner + "-prompt");
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(
      JSON.stringify({ folderId: child }),
      prompt,
    );
    db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
    setSaved(owner, prompt, true);
    for (const view of ["results", "saved", "sent"] as const) {
      const cache = all(owner, { view, project });
      expect(cache.items.size).toBeGreaterThan(0);
      for (const { card } of cache.items.values())
        expect(card.context).toMatchObject({
          project_id: project,
          project_name: "Nested project",
        });
      db.prepare("UPDATE folders SET name='Renamed nested' WHERE id=?").run(
        project,
      );
      expectCurrent(owner, { view, project }, cache);
      for (const { card } of cache.items.values())
        expect(card.context.project_name).toBe("Renamed nested");
      db.prepare("UPDATE folders SET name='Nested project' WHERE id=?").run(
        project,
      );
    }
  },
);

it("rejects selection/owner/future cursors, unsupported filters, and arbitrary details through HTTP", async () => {
  setup("http");
  result("http");
  const response = await fetch(base);
  expect(response.status).toBe(200);
  const page = CardPageSchema.parse(await response.json());
  const headers = await fetch(base, { method: "HEAD" });
  expect(headers.status).toBe(200);
  expect(await headers.text()).toBe("");
  expect(
    (await fetch(base, { headers: { authorization: "Bearer invalid" } }))
      .status,
  ).toBe(401);
  for (const query of [
    "limit=0",
    "owner=foreign",
    "view=files",
    "q=unsupported",
    "project=foreign",
  ]) {
    expect((await fetch(base + "?" + query)).status).toBeGreaterThanOrEqual(
      400,
    );
  }
  expect((await fetch(base + "/changes?after=bad")).status).toBe(409);
  expect(() => cardChanges("contract", { after: page.revision })).toThrow(
    "Resynchronization required",
  );
  const [scope] = JSON.parse(
    Buffer.from(page.revision, "base64url").toString(),
  );
  const future = Buffer.from(
    JSON.stringify([scope, Number.MAX_SAFE_INTEGER]),
  ).toString("base64url");
  expect(() => cardChanges("http", { after: future })).toThrow(
    "Resynchronization required",
  );
  expect(() =>
    cardChanges("http", { view: "saved", after: page.revision }),
  ).toThrow("Resynchronization required");
  expect(() =>
    cardChanges("http", { view: "saved", after: page.revision, through: 0 }),
  ).toThrow("publication bound");
  expect((await fetch(base + "/m:personal-explicit")).status).toBe(404);
  const before = db
    .prepare("SELECT * FROM feed_revisions ORDER BY revision")
    .all();
  await fetch(base);
  await fetch(base + "/" + encodeURIComponent(page.items[0].card.id));
  await fetch(base + "/changes?after=" + page.revision);
  expect(
    db.prepare("SELECT * FROM feed_revisions ORDER BY revision").all(),
  ).toEqual(before);
});

it("migrates existing bookmarks/labels and preserves revision numbers and truthful timestamps", () => {
  const old = new Database(":memory:");
  old.pragma("foreign_keys=ON");
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql") && Number(f.split("-")[0]) < 97)
    .sort())
    old.exec(readFileSync("migrations/" + file, "utf8"));
  old.exec(`INSERT INTO conversations(id,owner_id,title,created_at) VALUES('old','old','Old',1);
    INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('old-message','old','old','assistant','Old answer',1);
    INSERT INTO message_bookmarks(owner_id,message_id,created_at) VALUES('old','old-message',10);
    INSERT INTO saved_labels VALUES('old','m:old-message','Old label',11);
    INSERT INTO artifacts(id,owner_id,title,kind,content,pinned,created_at,updated_at) VALUES('old-result','old','Old result','markdown','Retained output',1,2,3);`);
  const published = old.prepare("SELECT * FROM artifact_publications").all();
  const pins = old.prepare("SELECT * FROM artifact_bookmarks").all();
  let earlierEpoch: unknown;
  old
    .transaction(() => {
      for (const file of readdirSync("migrations")
        .filter((f) => f.endsWith(".sql") && Number(f.split("-")[0]) >= 97)
        .sort()) {
        if (file.startsWith("099-"))
          earlierEpoch = old
            .prepare("SELECT epoch FROM card_revision_domain")
            .get();
        old.exec(readFileSync("migrations/" + file, "utf8"));
      }
    })
    .immediate();
  expect(
    old.prepare("SELECT epoch FROM card_revision_domain").get(),
  ).not.toEqual(earlierEpoch);
  expect(old.prepare("SELECT * FROM artifact_publications").all()).toEqual(
    published,
  );
  expect(old.prepare("SELECT * FROM artifact_bookmarks").all()).toEqual(pins);
  expect(
    old
      .prepare(
        "SELECT created_at,updated_at FROM artifacts WHERE id='old-result'",
      )
      .get(),
  ).toEqual({ created_at: 2, updated_at: 3 });
  expect(
    old
      .prepare("SELECT * FROM feed_revisions WHERE object_id='old-message'")
      .get(),
  ).toMatchObject({ entity: "message", owner_id: "old" });
  expect(old.prepare("SELECT * FROM message_bookmarks").get()).toMatchObject({
    created_at: 10,
  });
  expect(old.prepare("SELECT * FROM saved_labels").get()).toMatchObject({
    label: "Old label",
    updated_at: 11,
  });
  old.exec("DELETE FROM messages WHERE id='old-message'");
  expect(
    old
      .prepare("SELECT * FROM feed_revisions WHERE object_id='old-message'")
      .get(),
  ).toBeTruthy();
  expect(old.prepare("SELECT * FROM message_bookmarks").all()).toEqual([]);
  old.close();
});

it("reconciles typed reader file links and display metadata without streaming body revisions", () => {
  setup("reader");
  const id = result("reader", {
    metadata: { uploaded: true, partial: true, rawObjectId: "reader-object" },
  });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  const cache = all("reader", { view: "saved" });
  const display = () => {
    const card = cache.items.get("a:" + id)!.card;
    expect(card.type).toBe("result");
    return card.type === "result" ? card.display : null;
  };
  expect(display()?.download).toBeNull();
  db.prepare(
    "INSERT INTO objects VALUES('reader-object','reader','Original','text/plain',X'01',1)",
  ).run();
  expectCurrent("reader", { view: "saved" }, cache);
  expect(display()?.download).toBe("/api/objects/reader-object");
  db.prepare(
    "UPDATE objects SET owner_id='other' WHERE id='reader-object'",
  ).run();
  expectCurrent("reader", { view: "saved" }, cache);
  expect(display()?.download).toBeNull();
  db.prepare(
    "UPDATE objects SET owner_id='reader' WHERE id='reader-object'",
  ).run();
  expectCurrent("reader", { view: "saved" }, cache);
  expect(display()?.download).toBe("/api/objects/reader-object");
  db.prepare("DELETE FROM objects WHERE id='reader-object'").run();
  expectCurrent("reader", { view: "saved" }, cache);
  expect(display()?.download).toBeNull();
  db.prepare(
    "UPDATE artifacts SET metadata=json_set(metadata,'$.size',1024,'$.text',json('true'),'$.source',json(?),'$.connectionId','private','$.appResource',json(?)) WHERE id=?",
  ).run(
    '{"url":"https://example.com","title":"Reference"}',
    '{"html":"private app"}',
    id,
  );
  expectCurrent("reader", { view: "saved" }, cache);
  expect(display()).toMatchObject({
    size: 1024,
    text: true,
    source: { url: "https://example.com", title: "Reference" },
    refreshable: false,
    app: true,
  });
  expect(JSON.stringify(display())).not.toContain("private");
  db.prepare(
    "UPDATE artifacts SET metadata=json_set(metadata,'$.tool','refresh-tool','$.arguments',json('{}')) WHERE id=?",
  ).run(id);
  expectCurrent("reader", { view: "saved" }, cache);
  expect(display()?.refreshable).toBe(true);
  for (const args of [null, [], "invalid"]) {
    db.prepare(
      "UPDATE artifacts SET metadata=json_set(metadata,'$.arguments',json(?)) WHERE id=?",
    ).run(JSON.stringify(args), id);
    expectCurrent("reader", { view: "saved" }, cache);
    expect(display()?.refreshable).toBe(false);
  }
  const revision = cache.revision;
  db.prepare("UPDATE artifacts SET content='A partial chunk' WHERE id=?").run(
    id,
  );
  expect(
    cardChanges("reader", { view: "saved", after: revision }).items,
  ).toEqual([]);
  db.prepare(
    "UPDATE artifacts SET metadata=json_set(metadata,'$.partial',json('false')) WHERE id=?",
  ).run(id);
  expectCurrent("reader", { view: "saved" }, cache);
  expect(cache.items.get("a:" + id)!.card.content).toBe("A partial chunk");
});

it("keeps reusable prompt snippets out of content collections while exposing their conversion to results", () => {
  setup("snippets");
  const id = result("snippets", { metadata: { snippet: true } });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  const resultCache = all("snippets", { view: "results" }),
    savedCache = all("snippets", { view: "saved" });
  expect(resultCache.items.size).toBe(0);
  expect(savedCache.items.size).toBe(0);
  expect(() => cardDetail("snippets", "a:" + id)).toThrow("Card not found");
  for (const snippet of [false, 0, "", null]) {
    db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
      JSON.stringify({ snippet }),
      id,
    );
    expectCurrent("snippets", { view: "results" }, resultCache);
    expect(resultCache.items.size).toBe(1);
    expect(cardDetail("snippets", "a:" + id).id).toBe("a:" + id);
    expectCurrent("snippets", { view: "saved" }, savedCache);
    expect([...savedCache.items.keys()]).toEqual(
      listSaved("snippets").items.map((item) => item.key),
    );
    db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
      '{"snippet":true}',
      id,
    );
    expectCurrent("snippets", { view: "results" }, resultCache);
    expect(resultCache.items.size).toBe(0);
  }
  db.prepare("UPDATE artifacts SET metadata='{}' WHERE id=?").run(id);
  expectCurrent("snippets", { view: "results" }, resultCache);
  expectCurrent("snippets", { view: "saved" }, savedCache);
  expect(resultCache.items.size).toBe(1);
  expect(savedCache.items.size).toBe(1);
});

it("keeps provider model aliases owner-scoped and reconciles their catalog dependencies", () => {
  setup("model-labels");
  const insert = db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES('model-account',?,'anthropic','Private account','never-public','disconnected',?,1)",
  );
  const catalog = (version: string) =>
    JSON.stringify([
      {
        id: "default",
        name: "Default",
        resolvedModel: "claude-opus-" + version,
      },
    ]);
  insert.run("model-labels", catalog("5-5"));
  const id = result("model-labels", {
    metadata: {
      model: "default",
      provider: "anthropic",
      connectionId: "model-account",
    },
  });
  result("model-labels", {
    metadata: {
      model: "default",
      resolvedModel: "claude-opus-4-8",
      connectionId: "model-account",
    },
  });
  result("model-labels", { metadata: { connectionId: "model-account" } });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  const results = all("model-labels", { view: "results" }),
    saved = all("model-labels", { view: "saved" });
  const check = (label: string) => {
    expectCurrent("model-labels", { view: "results" }, results);
    expectCurrent("model-labels", { view: "saved" }, saved);
    const card = cardDetail("model-labels", "a:" + id);
    expect(card.type === "result" && card.display.model).toBe(label);
    expect(results.items.get(card.id)?.card).toEqual(card);
    expect(saved.items.get(card.id)?.card).toEqual(card);
    expect(JSON.stringify(card)).not.toContain("model-account");
    expect(JSON.stringify(card)).not.toContain("never-public");
  };
  check("Claude Opus 5.5");
  db.prepare("UPDATE connections SET models=? WHERE id='model-account'").run(
    catalog("5-6"),
  );
  expect(
    cardChanges("model-labels", {
      view: "results",
      after: results.revision,
    }).items.map((entry) => entry.card.id),
  ).toEqual(["a:" + id]);
  check("Claude Opus 5.6");
  db.prepare(
    "UPDATE connections SET owner_id='foreign' WHERE id='model-account'",
  ).run();
  check("default");
  db.prepare(
    "UPDATE connections SET owner_id='model-labels',provider='openai' WHERE id='model-account'",
  ).run();
  check("default");
  db.prepare(
    "UPDATE connections SET provider='anthropic' WHERE id='model-account'",
  ).run();
  check("Claude Opus 5.6");
  db.prepare(
    "UPDATE artifacts SET metadata=json_set(metadata,'$.provider','openai') WHERE id=?",
  ).run(id);
  check("default");
  db.prepare(
    "UPDATE artifacts SET metadata=json_set(metadata,'$.provider','anthropic','$.resolvedModel','claude-opus-4-8') WHERE id=?",
  ).run(id);
  check("Claude Opus 4.8");
  db.prepare("UPDATE connections SET models=? WHERE id='model-account'").run(
    catalog("5-7"),
  );
  expect(
    cardChanges("model-labels", { view: "results", after: results.revision })
      .items,
  ).toEqual([]);
  check("Claude Opus 4.8");
  db.prepare(
    "UPDATE artifacts SET metadata=json_remove(metadata,'$.resolvedModel') WHERE id=?",
  ).run(id);
  check("Claude Opus 5.7");
  db.prepare("DELETE FROM connections WHERE id='model-account'").run();
  check("default");
  insert.run("foreign", catalog("5-8"));
  check("default");
  db.prepare(
    "UPDATE connections SET owner_id='model-labels' WHERE id='model-account'",
  ).run();
  check("Claude Opus 5.8");
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT a.id FROM artifacts a WHERE a.owner_id=? AND json_extract(a.metadata,'$.connectionId')=?",
    )
    .all("model-labels", "model-account");
  expect(JSON.stringify(plan)).toContain("card_artifact_model_connection");
});

it("invalidates partial Saved display changes without revising every body chunk", () => {
  const owner = "partial-display";
  setup(owner);
  const id = result(owner, { metadata: { partial: true } });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  let revision = listCards(owner, { view: "saved" }).revision;
  const metadata: Record<string, unknown> = { partial: true };
  for (const [key, value] of Object.entries({
    model: "alias",
    resolvedModel: "recorded",
    tool: "browser_open",
    origin: "import",
    uploaded: true,
    upload: true,
    mime: "text/plain",
    name: "answer.txt",
  })) {
    metadata[key] = value;
    db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
      JSON.stringify(metadata),
      id,
    );
    const delta = cardChanges(owner, { view: "saved", after: revision });
    expect(
      delta.items.map((entry) => entry.card.id),
      key,
    ).toContain("a:" + id);
    expect(delta.items[0].card).toEqual(cardDetail(owner, "a:" + id));
    revision = delta.revision;
    db.prepare("UPDATE artifacts SET content=content||' chunk' WHERE id=?").run(
      id,
    );
    expect(
      cardChanges(owner, { view: "saved", after: revision }).items,
    ).toEqual([]);
  }
  db.prepare(
    "UPDATE artifacts SET metadata=json_set(metadata,'$.partial',json('false')) WHERE id=?",
  ).run(id);
  expect(
    cardChanges(owner, { view: "saved", after: revision }).items[0].card
      .content,
  ).toContain("chunk");
});

it("requires existing collection and page cursors to reset when the reader projection migrates", () => {
  const owner = "projection-upgrade";
  setup(owner);
  for (let n = 0; n < 2; n++) {
    const id = result(owner);
    db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(id);
  }
  const before = listCards(owner, { view: "saved", limit: 1 });
  expect(before.next).not.toBeNull();
  const migration = readFileSync(
    "migrations/099-card-reader-display.sql",
    "utf8",
  );
  db.transaction(() => {
    // Put this isolated fixture's reader DDL back at 098, preserving rows and
    // real production cursors, then execute the actual upgrade migration.
    for (const match of migration.matchAll(/CREATE (INDEX|TRIGGER) (\w+)/g))
      db.exec(`DROP ${match[1]} ${match[2]}`);
    db.prepare("DELETE FROM schema_version WHERE version=99").run();
    db.exec(migration);
  }).immediate();
  expect(() =>
    cardChanges(owner, { view: "saved", after: before.revision }),
  ).toThrowError(expect.objectContaining({ status: 409 }));
  expect(() =>
    listCards(owner, { view: "saved", before: before.next! }),
  ).toThrowError(expect.objectContaining({ status: 400 }));
  expect(listCards(owner, { view: "saved" }).items).toHaveLength(2);
});

it("Done preserves independent completion identities, full bodies and exact dismissal deltas", async () => {
  const { feed, setDoneCardHidden } =
    await import("../src/server/mobile-return");
  setup("done-contract");
  message("done-contract", "done-first", "assistant", {}, 10);
  message("done-contract", "done-second", "assistant", {}, 20);
  db.prepare("UPDATE messages SET content=? WHERE id='done-first'").run(
    "Answer ".repeat(1000),
  );
  const cache = all("done-contract", { view: "done" }, 1);
  expect([...cache.items.keys()]).toEqual([
    "d:run:done-second",
    "d:run:done-first",
  ]);
  expect(cache.items.get("d:run:done-first")?.card.content).toHaveLength(7000);
  const legacy = feed("done-contract", { filter: "done" });
  expect(
    [...cache.items.values()].map(
      (e) => e.card.type === "done" && e.card.display.done_card_key,
    ),
  ).toEqual(legacy.items.map((i) => i.done_card_key));
  db.prepare("UPDATE runs SET state='running' WHERE id='done-second'").run();
  expectCurrent("done-contract", { view: "done" }, cache);
  expect(cache.items.has("d:run:done-first")).toBe(true);
  setDoneCardHidden("done-contract", "done-contract", {
    hidden: true,
    cardKey: "run:done-first",
  });
  expectCurrent("done-contract", { view: "done" }, cache);
  expect(cache.items.has("d:run:done-first")).toBe(false);
  setDoneCardHidden("done-contract", "done-contract", {
    hidden: false,
    cardKey: "run:done-first",
  });
  expectCurrent("done-contract", { view: "done" }, cache);
  expect(cache.items.has("d:run:done-first")).toBe(true);
  expect(cardDetail("done-contract", "d:run:done-first").content).toHaveLength(
    7000,
  );
  expect(() =>
    cardDetail("done-contract", "d:run:done-first", ["read"]),
  ).toThrow();
  expect(() => cardDetail("other-owner", "d:run:done-first")).toThrow();
});

it("Done imports, ties, explicit Workspace and idle fallbacks converge", () => {
  setup("done-imports");
  message("done-imports", "done-workspace", "assistant", {}, 10);
  db.prepare("UPDATE runs SET payload=? WHERE id='done-workspace'").run(
    JSON.stringify({ folderId: null }),
  );
  const cache = all("done-imports", { view: "done" }, 1);
  for (const id of ["import-a", "import-b"])
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,'done-imports','done-imports','assistant','Imported',10)",
    ).run(id);
  expectCurrent("done-imports", { view: "done" }, cache);
  expect(cache.items.size).toBe(3);
  expect(
    listCards("done-imports", {
      view: "done",
      project: "done-imports",
    }).items.map((i) => i.card.id),
  ).toEqual(["d:message:import-b", "d:message:import-a"]);
  db.prepare("DELETE FROM messages WHERE owner_id='done-imports'").run();
  db.prepare(
    "UPDATE runs SET state='cancelled' WHERE id='done-workspace'",
  ).run();
  expectCurrent("done-imports", { view: "done" }, cache);
  expect(cache.items.size).toBe(1);
  expect([...cache.items.values()][0].card.content).toBe("");
});

it("Done reconciles more than eighty newer results without losing loaded history", () => {
  setup("done-backlog");
  message("done-backlog", "done-old", "assistant", {}, 1);
  const cache = all("done-backlog", { view: "done" });
  const insert = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,'done-backlog','done-backlog','assistant','Imported answer',?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 250; i++) insert.run("backlog-" + i, 2 + i);
  })();
  expectCurrent("done-backlog", { view: "done" }, cache);
  expect(cache.items.size).toBe(251);
  expect(cache.items.has("d:run:done-old")).toBe(true);
  setSaved("done-backlog", "done-old", true);
  expectCurrent("done-backlog", { view: "done" }, cache);
  expect(cache.items.get("d:run:done-old")!.card.saved).toBe(true);
  db.prepare(
    "UPDATE conversations SET title='Renamed' WHERE id='done-backlog'",
  ).run();
  expectCurrent("done-backlog", { view: "done" }, cache);
  expect(
    cache.items.get("d:message:backlog-0")!.card.context.conversation_title,
  ).toBe("Renamed");
});

it("Done detail accepts cards visible through explicit hidden-team history", () => {
  setup("done-team");
  message("done-team", "team-answer", "assistant", {});
  db.prepare(
    "INSERT INTO teams(id,owner_id,name,manager_id,hide_results_from_feed,created_at) VALUES('done-hidden','done-team','Hidden','done-team',1,1)",
  ).run();
  db.prepare(
    "UPDATE conversations SET team_id='done-hidden' WHERE id='done-team'",
  ).run();
  expect(listCards("done-team", { view: "done" }).items).toHaveLength(0);
  expect(
    listCards("done-team", { view: "done", teams: "done-hidden" }).items,
  ).toHaveLength(1);
  expect(cardDetail("done-team", "d:run:team-answer").content).toBe(
    "Body team-answer",
  );
});

it("Done reconciles tied approval expiries in bounded batches without database writes", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  try {
    const owner = "done-expiry";
    db.transaction(() => {
      for (let i = 0; i < 250; i++) {
        const id = "expiry-" + i;
        db.prepare(
          "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,?,1)",
        ).run(id, owner, id);
        db.prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'user','Prompt',1)",
        ).run(id, owner, id);
        // Historical pending approvals can outlive their stopped run. Derive
        // attention from source rows, never write a retired Feed cache column.
        db.prepare(
          "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,'Prompt','cancelled',?,1,1)",
        ).run(id, owner, id, id);
        db.prepare(
          "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,?,?,?,'{}','pending',1,200)",
        ).run(id, owner, id, id);
      }
    })();
    const cache = all(owner, { view: "done" });
    expect(cache.items.size).toBe(0);
    clock.mockReturnValue(300);
    const first = cardChanges(owner, { view: "done", after: cache.revision });
    expect(first.items).toHaveLength(200);
    expect(first.more).toBe(true);
    expectCurrent(owner, { view: "done" }, cache);
    expect(cache.items.size).toBe(250);
    expect(
      [...cache.items.values()].every((entry) => entry.card.content === ""),
    ).toBe(true);
  } finally {
    clock.mockRestore();
  }
});

it("Done idle fallback reconciles acknowledging a failed run", () => {
  setup("done-ack");
  message("done-ack", "failed-idle", "assistant", { progress: true });
  db.prepare("UPDATE runs SET state='failed' WHERE id='failed-idle'").run();
  const cache = all("done-ack", { view: "done" });
  expect(cache.items.size).toBe(0);
  db.prepare(
    "UPDATE runs SET attention_dismissed_at=100 WHERE id='failed-idle'",
  ).run();
  expectCurrent("done-ack", { view: "done" }, cache);
  expect(cache.items.size).toBe(1);
  expect([...cache.items.values()][0].card.content).toBe("");
});

it("Done removes expired stopped-pull footers through changes without a write", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  try {
    setup("done-pull-expiry");
    message("done-pull-expiry", "pull-answer", "assistant", {});
    db.prepare(
      "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,created_at,updated_at) VALUES('done-pull-watch','done-pull-expiry','done-pull-expiry','done-pull-expiry','fixture','repo',1,'stopped',1,1)",
    ).run();
    const cache = all("done-pull-expiry", { view: "done" });
    const card = cache.items.get("d:run:pull-answer")!.card;
    expect(card.type === "done" && card.display.pull?.number).toBe(1);
    clock.mockReturnValue(604800002);
    expectCurrent("done-pull-expiry", { view: "done" }, cache);
    const updated = cache.items.get("d:run:pull-answer")!.card;
    expect(updated.type === "done" && updated.display.pull).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

it("Done invalidates only candidate cards for visible pull changes and skips unrelated maintenance", () => {
  setup("done-cost");
  message("done-cost", "cost-answer", "assistant", {});
  db.transaction(() => {
    for (let i = 0; i < 500; i++)
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,'done-cost','done-cost','user','Old prompt',1)",
      ).run("cost-prompt-" + i);
  })();
  db.prepare(
    "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,created_at,updated_at) VALUES('cost-watch','done-cost','done-cost','done-cost','fixture','repo',1,'watching',1,1)",
  ).run();
  const cache = all("done-cost", { view: "done" });
  const revision = () =>
    (
      db
        .prepare(
          "SELECT max(revision) r FROM done_card_revisions WHERE owner_id='done-cost'",
        )
        .get() as { r: number }
    ).r;
  const before = revision();
  db.prepare(
    "UPDATE pr_watches SET next_poll_at=10 WHERE id='cost-watch'",
  ).run();
  db.prepare(
    "INSERT INTO conversation_positions(owner_id,conversation_id,position_message_id,updated_at) VALUES('done-cost','done-cost','cost-answer',1)",
  ).run();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('cost-unrelated','done-cost','project','Other',1)",
  ).run();
  db.prepare(
    "UPDATE folders SET name='Renamed unrelated' WHERE id='cost-unrelated'",
  ).run();
  expect(revision()).toBe(before);
  db.prepare("UPDATE pr_watches SET read_at=20 WHERE id='cost-watch'").run();
  const delta = cardChanges("done-cost", {
    view: "done",
    after: cache.revision,
  });
  expect(delta.items.map((item) => item.card.id)).toEqual([
    "d:run:cost-answer",
  ]);
  expect(delta.removed).toEqual([]);
  expect(delta.more).toBe(false);
  expectCurrent("done-cost", { view: "done" }, cache);
});

it("adds Done projection to populated pre-104 databases without rewriting existing history", () => {
  const fixture = new Database(":memory:");
  try {
    fixture.exec(
      "CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
    );
    for (const name of readdirSync("migrations")
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      if (Number(name.slice(0, 3)) >= 104) continue;
      fixture.exec(readFileSync(join("migrations", name), "utf8"));
    }
    fixture
      .prepare(
        "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('before-upgrade','before-upgrade','Existing history',1)",
      )
      .run();
    fixture
      .prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('before-answer','before-upgrade','before-upgrade','assistant','Preserved answer',1)",
      )
      .run();
    fixture.exec(readFileSync("migrations/104-done-cards.sql", "utf8"));
    // Upgrade an already-applied 104, preserving its rows and revision domain.
    fixture
      .prepare(
        "UPDATE messages SET metadata=json_object('partial',json('true')) WHERE id='before-answer'",
      )
      .run();
    fixture.exec(
      readFileSync("migrations/105-done-card-invalidation.sql", "utf8"),
    );
    const revision = fixture
      .prepare("SELECT MAX(revision) revision FROM done_card_revisions")
      .get() as { revision: number };
    fixture
      .prepare(
        "UPDATE messages SET content='Partial edit' WHERE id='before-answer'",
      )
      .run();
    expect(
      (
        fixture
          .prepare("SELECT MAX(revision) revision FROM done_card_revisions")
          .get() as { revision: number }
      ).revision,
    ).toBeGreaterThan(revision.revision);
    fixture
      .prepare(
        "UPDATE messages SET content='Preserved answer' WHERE id='before-answer'",
      )
      .run();
    expect(
      fixture
        .prepare(
          "SELECT key FROM done_card_candidates WHERE owner_id='before-upgrade'",
        )
        .all(),
    ).toEqual([{ key: "d:message:before-answer" }]);
    expect(
      fixture
        .prepare("SELECT content FROM messages WHERE id='before-answer'")
        .get(),
    ).toEqual({ content: "Preserved answer" });
    fixture
      .prepare(
        "UPDATE messages SET content='Updated answer' WHERE id='before-answer'",
      )
      .run();
    expect(
      fixture
        .prepare(
          "SELECT object_id FROM done_card_revisions WHERE owner_id='before-upgrade'",
        )
        .all(),
    ).toEqual([{ object_id: "d:message:before-answer" }]);
  } finally {
    fixture.close();
  }
});

it("Done reconciles Workspace renames for ordinary folders outside its parent subtree", () => {
  setup("done-workspace-name");
  const workspace = ensureWorkspaceProject("done-workspace-name");
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('workspace-loose-folder','done-workspace-name','folder','Loose folder',1)",
  ).run();
  message("done-workspace-name", "workspace-name-answer", "assistant", {});
  db.prepare("UPDATE runs SET payload=? WHERE id='workspace-name-answer'").run(
    JSON.stringify({ folderId: "workspace-loose-folder" }),
  );
  const cache = all("done-workspace-name", { view: "done" });
  db.prepare("UPDATE folders SET name='Renamed Workspace' WHERE id=?").run(
    workspace,
  );
  expectCurrent("done-workspace-name", { view: "done" }, cache);
  const card = cache.items.get("d:run:workspace-name-answer")!.card;
  expect(card.context.project_name).toBe("Renamed Workspace");
  expect(card.type === "done" && card.display.position_message_id).toBeNull();
});

it("Done revises eligible partial answers and preserves conversation-agent attribution", async () => {
  const owner = "done-partial-agent";
  setup(owner);
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('historical-agent',?,'Historical','historical','openai','fixture',1)",
  ).run(owner);
  message(owner, "partial-run", "assistant", { partial: true });
  message(owner, "partial-import", "assistant", { partial: true });
  db.prepare("UPDATE messages SET run_id=NULL WHERE id='partial-import'").run();
  db.prepare(
    "UPDATE runs SET agent_id='historical-agent' WHERE id='partial-run'",
  ).run();
  const cache = all(owner, { view: "done" });
  for (const id of ["partial-run", "partial-import"]) {
    db.prepare(
      "UPDATE messages SET content='Updated partial answer',metadata=json_set(metadata,'$.attachments',json('[]')) WHERE id=?",
    ).run(id);
  }
  expectCurrent(owner, { view: "done" }, cache);
  expect(cache.items.get("d:run:partial-run")!.card.content).toBe(
    "Updated partial answer",
  );
  expect(cache.items.get("d:message:partial-import")!.card.content).toBe(
    "Updated partial answer",
  );
  expect(cache.items.get("d:message:partial-import")!.card.author).toEqual({
    kind: "unknown",
    id: null,
    name: null,
    provider: null,
  });
  const { feed } = await import("../src/server/mobile-return");
  expect(
    listCards(owner, { view: "done", agent: "historical-agent" }).items,
  ).toHaveLength(0);
  const cards = listCards(owner, { view: "done", agent: owner }).items;
  expect(cards.map((e) => e.card.source.agent_id)).toEqual(
    cards.map(() => owner),
  );
  expect(
    cards.map((e) => e.card.type === "done" && e.card.display.done_card_key),
  ).toEqual(
    feed(owner, { filter: "done", agent: owner }).items.map(
      (e) => e.done_card_key,
    ),
  );
});
