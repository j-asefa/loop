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
const draft = (folder?: string) =>
  saveArtifact("alice", {
    title: "Partial file",
    kind: "file",
    content: "searchable draft",
    folder,
    metadata: { partial: true },
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

it("moves partial draft search scope and undo immediately without indexing streamed text", () => {
  const oldFolder = id(),
    newFolder = id();
  for (const folder of [oldFolder, newFolder])
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,'alice','project',?,1)",
    ).run(folder, folder);
  const artifact = draft(oldFolder);
  db.prepare(
    "INSERT INTO embeddings VALUES(?,'alice','fixture','[1]','hash',1)",
  ).run("artifact:" + artifact);
  db.prepare(
    "UPDATE artifacts SET content='streamed replacement' WHERE id=?",
  ).run(artifact);
  const before = resultsRevision("alice");
  const moved = moveArtifact("alice", artifact, newFolder);
  expect(lexical("alice", "searchable", { folder: oldFolder })).toEqual([]);
  expect(
    lexical("alice", "searchable", { folders: [newFolder] }).map((r) => r.id),
  ).toEqual(["artifact:" + artifact]);
  expect(lexical("bob", "searchable", { folder: newFolder })).toEqual([]);
  expect(lexical("alice", "replacement", { folder: newFolder })).toEqual([]);
  expect(
    db
      .prepare("SELECT content,folder_id FROM search_documents WHERE id=?")
      .get("artifact:" + artifact),
  ).toEqual({ content: "searchable draft", folder_id: newFolder });
  expect(
    db
      .prepare("SELECT content_hash FROM embeddings WHERE document_id=?")
      .get("artifact:" + artifact),
  ).toEqual({ content_hash: "hash" });
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
    lexical("alice", "searchable", { folder: oldFolder }).map((r) => r.id),
  ).toEqual(["artifact:" + artifact]);
  expect(lexical("alice", "searchable", { folders: [newFolder] })).toEqual([]);
  db.prepare("UPDATE artifacts SET kind='diagram' WHERE id=?").run(artifact);
  expect(
    lexical("alice", "searchable", { kind: "diagram" }).map((r) => r.id),
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
