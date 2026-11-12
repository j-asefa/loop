import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import {
  fileArtifactSql,
  resultOutputSql as newResultOutputSql,
  traceArtifactSql as newTraceArtifactSql,
} from "../src/server/sql/artifacts.js";

// The filters this PR replaces, kept verbatim as fixtures (D3). They read the
// artifact metadata flags and checkpoint relations.
const oldTraceArtifactSql = `(json_extract(a.metadata,'$.tool') IS NOT NULL
  OR (json_extract(a.metadata,'$.native')=1 AND NOT EXISTS(
    SELECT 1 FROM agent_checkpoints cp WHERE cp.run_id=a.run_id
      AND cp.artifact_id=a.id AND cp.stage='done' AND length(trim(a.content))>0))
  OR EXISTS(SELECT 1 FROM agent_checkpoints cp WHERE cp.run_id=a.run_id AND cp.artifact_id<>a.id))`;
const oldFinishedArtifactSql = `(a.run_id IS NULL OR r.state='completed')`;
const oldFileArtifactSql = `(${oldFinishedArtifactSql} OR json_extract(a.metadata,'$.uploaded')=1)`;
const oldResultOutputSql = `${oldFinishedArtifactSql} AND NOT COALESCE(${oldTraceArtifactSql},0)
  AND json_extract(a.metadata,'$.upload') IS NOT 1
  AND json_extract(a.metadata,'$.uploaded') IS NOT 1
  AND COALESCE(json_extract(a.metadata,'$.partial'),0)=0`;

const runStates = [
  "queued",
  "running",
  "pausing",
  "paused",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

function buildDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync("migrations/" + file, "utf8"));
  return db;
}

// One artifact row with the flags and checkpoint relation that match its role
// (what the backfill would have assigned), plus the run state.
function seed(
  db: Database.Database,
  id: string,
  role: string,
  state: string,
  checkpoint: "none" | "pending" | "done" | "other",
  content: string,
  flags: Record<string, unknown> = {},
  { hidden, archived }: { hidden?: number; archived?: number } = {},
) {
  // One checkpoint row per run (run_id is agent_checkpoints' primary key), so
  // each seeded artifact gets its own run to keep the checkpoint relations
  // unambiguous.
  const run = "run-" + id;
  db.prepare(
    "INSERT OR REPLACE INTO runs(id,owner_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,'owner','I','" +
      state +
      "','k-" +
      id +
      "','{}',1,1)",
  ).run(run);
  db.prepare(
    "INSERT OR REPLACE INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,'owner',NULL,'C',1)",
  ).run("c-" + run);
  void state;
  const meta = JSON.stringify({ ...flags });
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,role,content,metadata,run_id,feed_hidden,archived,created_at,updated_at) VALUES(?,?,'T','markdown',?,?,?,?,?,?,1,1)",
  ).run(id, "owner", role, content, meta, run, hidden ?? 0, archived ?? 0);
  if (role === "answer") {
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'owner','c-" +
        run +
        "','" +
        run +
        "','assistant','','{}',1)",
    ).run("m-" + id);
    db.prepare(
      "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history) VALUES(?,?,?,'[]')",
    ).run(run, "m-" + id, id);
    if (checkpoint === "pending")
      db.prepare(
        "UPDATE agent_checkpoints SET stage='pending' WHERE artifact_id=?",
      ).run(id);
    if (checkpoint === "done")
      db.prepare(
        "UPDATE agent_checkpoints SET stage='done' WHERE artifact_id=?",
      ).run(id);
  }
  if (checkpoint === "other") {
    // A second artifact of the same run holds the run's checkpoint, so this
    // row is not the answer (trace by the other-checkpoint clause).
    db.prepare(
      "INSERT INTO artifacts(id,owner_id,title,kind,role,content,metadata,run_id,created_at,updated_at) VALUES(?,'owner','O','markdown','answer','O','{}',?,1,1)",
    ).run("other-" + id, run);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'owner','c-" +
        run +
        "','" +
        run +
        "','assistant','','{}',1)",
    ).run("m-other-" + id);
    db.prepare(
      "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history) VALUES(?,?,?,'[]')",
    ).run(run, "m-other-" + id, "other-" + id);
  }
}

const selectIds = (db: Database.Database, fragment: string) =>
  new Set(
    (
      db
        .prepare(
          `SELECT a.id FROM artifacts a LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE ${fragment}`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id),
  );

it("the role filters select exactly the rows the flag filters select", () => {
  const db = buildDb();
  let n = 0;
  // Every role x run state x checkpoint stage x content combination the
  // producers can write; hidden and archived variants too.
  for (const state of runStates)
    for (const content of ["", "Body"])
      for (const checkpoint of ["none", "pending", "done", "other"] as const) {
        const answer = checkpoint !== "other";
        const role = answer ? "answer" : "trace";
        seed(db, "a" + n++, role, state, checkpoint, content, {
          ...(role === "answer"
            ? { messageId: "m-" + n, native: checkpoint === "pending" ? 1 : 0 }
            : { tool: "fixture_tool", fib: 1 }),
          ...(content ? {} : { partial: checkpoint === "pending" ? 1 : 0 }),
        });
      }
  seed(db, "f-file-1", "file", "completed", "none", "bytes", {
    uploaded: true,
  });
  seed(db, "f-file-2", "file", "running", "none", "bytes", { uploaded: true });
  seed(db, "u-1", "upload", "completed", "none", "bytes", { upload: true });
  seed(db, "i-1", "import", "completed", "none", "text", {
    origin: "import",
  });
  seed(db, "s-1", "snippet", "running", "none", "text", { snippet: true });
  seed(db, "s-2", "snippet", "completed", "none", "text", { snippet: true });
  seed(db, "h-1", "answer", "completed", "done", "Body", {}, { hidden: 1 });
  seed(db, "h-2", "answer", "completed", "done", "Body", {}, { archived: 1 });
  seed(
    db,
    "h-3",
    "answer",
    "completed",
    "done",
    "Body",
    {},
    {
      hidden: 1,
      archived: 1,
    },
  );

  const oldResults = selectIds(db, oldResultOutputSql);
  const newResults = selectIds(db, newResultOutputSql);
  expect([...newResults].filter((id) => !oldResults.has(id))).toEqual([]);
  expect([...oldResults].filter((id) => !newResults.has(id))).toEqual([]);

  const oldFiles = selectIds(db, oldFileArtifactSql);
  const newFiles = selectIds(db, fileArtifactSql);
  expect([...newFiles].filter((id) => !oldFiles.has(id))).toEqual([]);
  expect([...oldFiles].filter((id) => !newFiles.has(id))).toEqual([]);

  // Trace classification drives search exclusion; keep it equivalent too.
  const oldTrace = selectIds(db, oldTraceArtifactSql);
  const newTrace = selectIds(db, newTraceArtifactSql);
  expect([...newTrace].filter((id) => !oldTrace.has(id))).toEqual([]);
  expect([...oldTrace].filter((id) => !newTrace.has(id))).toEqual([]);
});

it("documents the divergence for completed-run artifacts with no checkpoint", () => {
  // The old filter only probed tool/native flags and other checkpoint rows, so
  // a completed run whose checkpoint is absent entirely (legacy data; the dry
  // run found six such rows on the owner's copy) slipped into Results. D2's
  // recognition puts every non-checkpoint artifact of a run in the trace
  // role, so the role filter excludes it: the one named difference.
  const db = buildDb();
  seed(db, "no-checkpoint", "trace", "completed", "none", "Legacy output");
  db.prepare("DELETE FROM agent_checkpoints").run();
  const oldResults = selectIds(db, oldResultOutputSql);
  const newResults = selectIds(db, newResultOutputSql);
  expect(oldResults.has("no-checkpoint")).toBe(true);
  expect(newResults.has("no-checkpoint")).toBe(false);
});

it("documents the one unreachable divergence: partial on a completed run", () => {
  // Production never writes this: completion rewrites the answer's metadata
  // without partial (agent-runtime persist(false)), and the owner's data had
  // no partial flag on any completed run. The old filter's `partial=0` probe
  // is the only clause the role filter does not reproduce.
  const db = buildDb();
  seed(db, "unreachable", "answer", "completed", "done", "Body", {
    messageId: "m-x",
    partial: true,
  });
  const oldResults = selectIds(db, oldResultOutputSql);
  const newResults = selectIds(db, newResultOutputSql);
  expect(oldResults.has("unreachable")).toBe(false);
  expect(newResults.has("unreachable")).toBe(true);
});

it("keeps published run files out of search, as the previous filter did", () => {
  const db = buildDb();
  // The run's checkpoint names its answer; the published file shares the run
  // and carries text, which the old third trace clause removed from search.
  seed(db, "answer-1", "answer", "completed", "done", "Answer body");
  const fileId = "file-run-1";
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,role,content,metadata,run_id,created_at,updated_at) VALUES(?,'owner','F','file','file','File text','{\"uploaded\":true}',?,1,1)",
  ).run(
    fileId,
    (
      db.prepare("SELECT run_id FROM artifacts WHERE id='answer-1'").get() as {
        run_id: string;
      }
    ).run_id,
  );
  const oldTrace = selectIds(db, oldTraceArtifactSql);
  const newTrace = selectIds(db, newTraceArtifactSql);
  expect(oldTrace.has(fileId)).toBe(true);
  expect(newTrace.has(fileId)).toBe(true);
  // Still a result/file parity: the file is in the file collection, never a
  // result, under both filter pairs.
  expect(selectIds(db, oldResultOutputSql).has(fileId)).toBe(false);
  expect(selectIds(db, newResultOutputSql).has(fileId)).toBe(false);
  expect(selectIds(db, oldFileArtifactSql).has(fileId)).toBe(true);
  expect(selectIds(db, fileArtifactSql).has(fileId)).toBe(true);
});
