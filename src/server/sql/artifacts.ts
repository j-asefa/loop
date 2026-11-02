import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const mailFilesStatement = statement(
  "SELECT id,title name FROM artifacts WHERE owner_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id",
);
const mailFilesRow = z.object({
  id: QueryRecords.artifacts.shape.id,
  name: QueryRecords.artifacts.shape.title,
});
export function mailFiles(db: Database.Database, owner: string, files: string) {
  return mailFilesStatement(db)
    .all(owner, files)
    .map((row) => parseRecord(mailFilesRow, row, "artifacts"));
}

const ownedFileSizeStatement = statement(
  "SELECT f.size FROM artifacts a JOIN artifact_objects f ON f.artifact_id=a.id AND f.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=?",
);
const ownedFileSizeRow = QueryRecords.artifact_objects.pick({ size: true });
export function ownedFileSize(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = ownedFileSizeStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedFileSizeRow, row, "artifacts");
}

const ownedStatement = statement(
  "SELECT * FROM artifacts WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.artifacts, row, "artifacts");
}

const streamInitialStatement = statement(
  "UPDATE artifacts SET content=?,metadata=?,updated_at=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM artifact_versions WHERE artifact_id=artifacts.id AND version>1)",
);
export function streamInitial(
  db: Database.Database,
  content: string,
  metadata: string,
  updated: number,
  artifact: string,
) {
  return streamInitialStatement(db).run(content, metadata, updated, artifact);
}

const feedHiddenStatement = statement(
  "UPDATE artifacts SET feed_hidden=? WHERE id=? AND owner_id=?",
);
export function feedHidden(
  db: Database.Database,
  hidden: number,
  id: string,
  owner: string,
) {
  return feedHiddenStatement(db).run(hidden, id, owner);
}

const insertStatement = statement(
  "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,folder_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string | null,
  conversation: string | null,
  run: string | null,
  title: string,
  kind: string,
  content: string,
  metadata: string,
  folder: string | null,
  created: number,
  updated: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    agent,
    conversation,
    run,
    title,
    kind,
    content,
    metadata,
    folder,
    created,
    updated,
  );
}

// The same rule must govern initial pages and update tombstones. A running or
// failed placeholder is not an output, and tool artifacts belong to Traces.
// Native is provenance, not a tool marker: a completed checkpoint owns the
// native harness's final answer, including answers saved by earlier versions.
export const traceArtifactSql = `(json_extract(a.metadata,'$.tool') IS NOT NULL
  OR (json_extract(a.metadata,'$.native')=1 AND NOT EXISTS(
    SELECT 1 FROM agent_checkpoints cp WHERE cp.run_id=a.run_id
      AND cp.artifact_id=a.id AND cp.stage='done' AND length(trim(a.content))>0))
  OR EXISTS(SELECT 1 FROM agent_checkpoints cp WHERE cp.run_id=a.run_id AND cp.artifact_id<>a.id))`;
export const finishedArtifactSql = `(a.run_id IS NULL OR r.state='completed')`;
export const fileArtifactSql = `(${finishedArtifactSql} OR json_extract(a.metadata,'$.uploaded')=1)`;
export const resultOutputSql = `${finishedArtifactSql} AND NOT COALESCE(${traceArtifactSql},0)
  AND json_extract(a.metadata,'$.upload') IS NOT 1
  AND json_extract(a.metadata,'$.uploaded') IS NOT 1
  AND COALESCE(json_extract(a.metadata,'$.partial'),0)=0`;

const pageStatement = statementVariants();
const pageRow = QueryRecords.artifacts.extend({
  run_state: z.string().nullable(),
  run_error: z.string().nullable(),
  cursor: z.number(),
  name: z.string().nullable(),
  provider: z.string().nullable(),
  team_id: z.string().nullable(),
});
export function page(
  db: Database.Database,
  options: {
    saved: boolean;
    files: boolean;
    teamCount: number;
    folder: boolean;
    agent: boolean;
    cursor: boolean;
  },
  values: readonly unknown[],
  limit: number,
) {
  const saved = options.saved;
  let where =
    "a.owner_id=? AND a.archived=0" +
    (saved ? " AND a.pinned=1" : " AND a.feed_hidden=0");
  if (options.teamCount)
    where +=
      " AND a.conversation_id IN (SELECT id FROM conversations WHERE owner_id=? AND team_id IN (" +
      Array(options.teamCount).fill("?").join(",") +
      "))";
  if (options.folder)
    where +=
      " AND EXISTS(SELECT 1 FROM json_each(?) WHERE value IS a.folder_id)";
  if (options.agent) where += " AND a.agent_id=?";
  if (options.cursor) where += " AND p.sequence<?";
  if (saved) where += ` AND ${fileArtifactSql}`;
  else if (options.files)
    where += ` AND ${fileArtifactSql} AND a.kind IN ('file','image','code','table','diagram','chart','workflow')`;
  else where += ` AND ${resultOutputSql}`;
  return pageStatement(
    `SELECT a.*,r.state run_state,r.error run_error,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,p.sequence AS cursor,g.name,g.provider,(SELECT team_id FROM conversations WHERE id=a.conversation_id) team_id FROM artifacts a JOIN ${saved ? "artifact_bookmarks" : "artifact_publications"} p ON p.artifact_id=a.id LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id LEFT JOIN agents g ON g.id=a.agent_id WHERE ${where} ORDER BY p.sequence DESC LIMIT ?`,
    db,
  )
    .all(...values, limit)
    .map((row) => parseRecord(pageRow, row, "artifacts"));
}
