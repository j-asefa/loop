import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { productionApp } from "./helpers/app";

const dir = mkdtempSync(join(tmpdir(), "loop-partial-actions-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { saveArtifact } = await import("../src/server/artifacts");
const { moveArtifact, undoMove } = await import("../src/server/filing");
const { lexical } = await import("../src/server/search");
const { resultsRevision, resultsUpdates } =
  await import("../src/server/results");
const app = await productionApp("alice");
afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
// A saved file draft. The artifact partial flag is gone (D4), so its writes
// are indexed immediately; only message-linked streaming answers defer.
const draft = (folder?: string) =>
  saveArtifact("alice", {
    title: "Draft file",
    kind: "file",
    content: "searchable draft",
    folder,
    role: "file",
  });
const version = (artifact: string) =>
  (
    db.prepare("SELECT version FROM artifacts WHERE id=?").get(artifact) as {
      version: number;
    }
  ).version;
const patch = (path: string, body: object) =>
  app.fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("moves draft search scope and undo immediately and indexes edits at once", () => {
  const oldFolder = id(),
    newFolder = id();
  for (const folder of [oldFolder, newFolder])
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,'alice','project',?,1)",
    ).run(folder, folder);
  const artifact = draft(oldFolder);
  const before = resultsRevision("alice");
  const moved = moveArtifact("alice", artifact, newFolder);
  expect(lexical("alice", "searchable", { folder: oldFolder })).toEqual([]);
  expect(
    lexical("alice", "searchable", { folders: [newFolder] }).map((r) => r.id),
  ).toEqual(["artifact:" + artifact]);
  expect(lexical("bob", "searchable", { folder: newFolder })).toEqual([]);
  // No artifact partial flag defers indexing any more: the edit is live.
  db.prepare(
    "UPDATE artifacts SET content='streamed replacement' WHERE id=?",
  ).run(artifact);
  expect(
    lexical("alice", "replacement", { folder: newFolder }).map((r) => r.id),
  ).toEqual(["artifact:" + artifact]);
  expect(
    db
      .prepare("SELECT content,folder_id FROM search_documents WHERE id=?")
      .get("artifact:" + artifact),
  ).toEqual({ content: "streamed replacement", folder_id: newFolder });
  expect(
    db
      .prepare("SELECT content_hash FROM embeddings WHERE document_id=?")
      .get("artifact:" + artifact),
  ).toBeUndefined();
  expect(
    resultsUpdates("alice", {
      after: before,
      through: 0,
      view: "files",
      folder: oldFolder,
    }).removed,
  ).toContain(artifact);
  expect(
    resultsUpdates("alice", {
      after: before,
      through: 0,
      view: "files",
      folder: newFolder,
    }).items.map((r) => r.id),
  ).toContain(artifact);
  undoMove("alice", moved.operation);
  expect(
    lexical("alice", "replacement", { folder: oldFolder }).map((r) => r.id),
  ).toEqual(["artifact:" + artifact]);
  expect(lexical("alice", "replacement", { folders: [newFolder] })).toEqual([]);
  db.prepare("UPDATE artifacts SET kind='diagram' WHERE id=?").run(artifact);
  expect(
    lexical("alice", "replacement", { kind: "diagram" }).map((r) => r.id),
  ).toContain("artifact:" + artifact);
});

it("emits removal deltas for hiding, unpinning and archiving visible partial files", async () => {
  const hidden = draft();
  let before = resultsRevision("alice");
  expect((await patch(`/api/results/${hidden}`, { hidden: true })).status).toBe(
    200,
  );
  expect(
    resultsUpdates("alice", { after: before, through: 0, view: "files" })
      .removed,
  ).toContain(hidden);
  const saved = draft();
  expect(
    (
      await patch(`/api/artifacts/${saved}`, {
        pinned: true,
        version: version(saved),
      })
    ).status,
  ).toBe(200);
  expect(
    resultsUpdates("alice", { after: 0, through: 0, saved: true }).items.map(
      (r) => r.id,
    ),
  ).toContain(saved);
  before = resultsRevision("alice");
  expect(
    (
      await patch(`/api/artifacts/${saved}`, {
        pinned: false,
        version: version(saved),
      })
    ).status,
  ).toBe(200);
  expect(
    resultsUpdates("alice", { after: before, through: 0, saved: true }).removed,
  ).toContain(saved);
  const archived = draft();
  before = resultsRevision("alice");
  expect(
    (
      await patch(`/api/artifacts/${archived}`, {
        archived: true,
        version: version(archived),
      })
    ).status,
  ).toBe(200);
  expect(
    resultsUpdates("alice", { after: before, through: 0, view: "files" })
      .removed,
  ).toContain(archived);
});

it("defers search and feed revisions for a message-linked answer until the message stops being partial", () => {
  const agent = id(),
    conv = id(),
    run = id(),
    msg = id();
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,'alice',?,'alice','pi','fixture',1)",
  ).run(agent, agent);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,'alice',?,'T',1)",
  ).run(conv, agent);
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,'alice',?,?,'I','running','k',1,1)",
  ).run(run, agent, conv);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,?,'assistant','','{}',1)",
  ).run(msg, conv, run);
  const artifact = saveArtifact("alice", {
    agent,
    conversation: conv,
    run,
    title: "Answer",
    content: "initial",
    metadata: { native: true, messageId: msg },
    role: "answer",
  });
  const embedding = () =>
    db
      .prepare("SELECT 1 FROM embeddings WHERE document_id=?")
      .get("artifact:" + artifact);
  const revision = () =>
    (
      db
        .prepare(
          "SELECT max(revision) r FROM feed_revisions WHERE owner_id='alice'",
        )
        .get() as { r: number }
    ).r;
  db.prepare(
    "INSERT INTO embeddings VALUES(?,'alice','fixture','[1]','hash',1)",
  ).run("artifact:" + artifact);
  const before = revision();
  // The linked message is still partial: the artifact's body updates are not
  // indexed and emit no feed revision (D4's churn guard, migration 160).
  db.prepare(
    "UPDATE messages SET metadata='{\"partial\":true}' WHERE id=?",
  ).run(msg);
  db.prepare(
    "UPDATE artifacts SET content='zephyr stream chunk' WHERE id=?",
  ).run(artifact);
  expect(lexical("alice", "zephyr", {})).toEqual([]);
  expect(revision()).toBe(before);
  expect(embedding()).toBeDefined();
  // Once the message clears partial, the next write indexes and revises.
  db.prepare(
    "UPDATE messages SET metadata='{\"partial\":false}' WHERE id=?",
  ).run(msg);
  db.prepare(
    "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history,stage) VALUES(?,?,?,'[]','done')",
  ).run(run, msg, artifact);
  db.prepare(
    "UPDATE artifacts SET content='zephyr final answer' WHERE id=?",
  ).run(artifact);
  expect(lexical("alice", "zephyr", {}).map((r) => r.id)).toEqual([
    "artifact:" + artifact,
  ]);
  expect(revision()).toBeGreaterThan(before);
  expect(embedding()).toBeUndefined();
});
