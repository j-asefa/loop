import { FOLDER_PROJECT } from "./folders.js";
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

const messageResultStatement = statement(
  "SELECT a.id,a.pinned FROM artifacts a JOIN messages m ON m.id=? AND m.owner_id=a.owner_id AND m.conversation_id=a.conversation_id WHERE a.owner_id=? AND a.archived=0 AND json_extract(a.metadata,'$.messageId')=m.id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1",
);
const messageResultRow = QueryRecords.artifacts.pick({
  id: true,
  pinned: true,
});
export function messageResult(
  db: Database.Database,
  message: string,
  owner: string,
) {
  const row = messageResultStatement(db).get(message, owner);
  return row === undefined
    ? undefined
    : parseRecord(messageResultRow, row, "artifacts");
}

const bookmarkStatement = statement(
  "UPDATE artifacts SET pinned=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND pinned<>?",
);
export function bookmark(
  db: Database.Database,
  pinned: number,
  updated: number,
  artifact: string,
  owner: string,
  previous: number,
) {
  return bookmarkStatement(db).run(pinned, updated, artifact, owner, previous);
}

const isBookmarkedStatement = statement(
  "SELECT 1 FROM artifacts a JOIN artifact_bookmarks p ON p.artifact_id=a.id WHERE a.id=? AND a.owner_id=? AND a.pinned=1 AND a.archived=0",
);
const isBookmarkedRow = z.object({ "1": z.number() });
export function isBookmarked(
  db: Database.Database,
  artifact: string,
  owner: string,
) {
  const row = isBookmarkedStatement(db).get(artifact, owner);
  return row === undefined
    ? undefined
    : parseRecord(isBookmarkedRow, row, "artifacts");
}

const snippetsStatement = statement(
  "SELECT id,title,content,created_at FROM (\n          SELECT id,title,content,created_at,rowid AS row,\n            row_number() OVER (\n              PARTITION BY trim(content,' '||char(9)||char(10)||char(13))\n              ORDER BY created_at DESC,rowid DESC\n            ) copy\n          FROM artifacts WHERE owner_id=? AND archived=0\n            AND (json_extract(metadata,'$.snippet')=1 OR title LIKE 'Saved prompt:%')\n        ) WHERE copy=1 ORDER BY created_at DESC,row DESC LIMIT 100",
);
const snippetsRow = QueryRecords.artifacts.pick({
  id: true,
  title: true,
  content: true,
  created_at: true,
});
export function snippets(db: Database.Database, owner: string) {
  return snippetsStatement(db)
    .all(owner)
    .map((row) => parseRecord(snippetsRow, row, "artifacts"));
}

const savedPageStatement =
  statement(`SELECT 'a:'||a.id key,COALESCE(p.saved_at,a.updated_at) saved_at,a.*,r.state run_state,r.error run_error,
        json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,g.name,g.provider,
        (SELECT team_id FROM conversations WHERE id=a.conversation_id) team_id,l.label saved_label
      FROM artifacts a JOIN artifact_bookmarks p ON p.artifact_id=a.id
      LEFT JOIN saved_labels l ON l.owner_id=a.owner_id AND l.item_key='a:'||a.id
      LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
      LEFT JOIN agents g ON g.id=a.agent_id
      WHERE a.owner_id=@owner AND a.archived=0 AND a.pinned=1 AND ${fileArtifactSql}
        AND json_extract(a.metadata,'$.snippet') IS NULL
        AND (@at IS NULL OR COALESCE(p.saved_at,a.updated_at)<@at OR (COALESCE(p.saved_at,a.updated_at)=@at AND 'a:'||a.id<@key))
        AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS a.folder_id))
        AND (@teams IS NULL OR a.conversation_id IN (SELECT id FROM conversations WHERE owner_id=@owner AND team_id IN (SELECT value FROM json_each(@teams))))
        AND (@q IS NULL OR a.title LIKE @q ESCAPE '\\' OR a.content LIKE @q ESCAPE '\\' OR l.label LIKE @q ESCAPE '\\')
      ORDER BY COALESCE(p.saved_at,a.updated_at) DESC,key DESC LIMIT @limit`);
const savedPageRow = QueryRecords.artifacts.extend({
  key: z.string(),
  saved_at: z.number(),
  run_state: z.string().nullable(),
  run_error: z.string().nullable(),
  name: z.string().nullable(),
  provider: z.string().nullable(),
  team_id: z.string().nullable(),
  saved_label: z.string().nullable(),
});
export function savedPage(
  db: Database.Database,
  params: {
    owner: string;
    at: number | null;
    key: string | null;
    limit: number;
    folders: string | null;
    teams: string | null;
    q: string | null;
  },
) {
  return savedPageStatement(db)
    .all(params)
    .map((row) => parseRecord(savedPageRow, row, "artifacts"));
}

const projectActivityStatement = statement(
  `WITH RECURSIVE ${FOLDER_PROJECT} SELECT fp.project_id,max(a.updated_at) last FROM artifacts a JOIN folder_project fp ON fp.id IS a.folder_id WHERE a.owner_id=@owner AND a.archived=0 GROUP BY fp.project_id`,
);
const projectActivityRow = z.object({
  project_id: z.string(),
  last: z.number(),
});
export function projectActivity(db: Database.Database, owner: string) {
  return projectActivityStatement(db)
    .all({ owner })
    .map((row) => parseRecord(projectActivityRow, row, "artifacts"));
}

const latestProjectResultsStatement =
  statement(`WITH RECURSIVE ${FOLDER_PROJECT} SELECT project_id,id,title,created_at FROM (
      SELECT fp.project_id,a.id,a.title,a.created_at,
        row_number() OVER (PARTITION BY fp.project_id ORDER BY p.sequence DESC) n
      FROM artifacts a JOIN artifact_publications p ON p.artifact_id=a.id
      JOIN folder_project fp ON fp.id IS a.folder_id
      LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
      WHERE a.owner_id=@owner AND a.archived=0 AND a.feed_hidden=0 AND ${resultOutputSql}
    ) WHERE n=1`);
const latestProjectResultsRow = z.object({
  project_id: z.string(),
  id: z.string(),
  title: z.string(),
  created_at: z.number(),
});
export function latestProjectResults(db: Database.Database, owner: string) {
  return latestProjectResultsStatement(db)
    .all({ owner })
    .map((row) => parseRecord(latestProjectResultsRow, row, "artifacts"));
}

const laterTargetStatement = statement(
  "SELECT a.id,a.title,substr(a.content,1,4000) content,a.conversation_id,json_extract(a.metadata,'$.messageId') message_id,a.folder_id,g.name agent_name,g.provider FROM artifacts a LEFT JOIN agents g ON g.id=a.agent_id AND g.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=?",
);
const laterTargetRow = QueryRecords.artifacts
  .pick({
    id: true,
    title: true,
    content: true,
    conversation_id: true,
    folder_id: true,
  })
  .extend({
    message_id: z.string().nullable(),
    agent_name: z.string().nullable(),
    provider: z.string().nullable(),
  });
export function laterTarget(
  db: Database.Database,
  target: string,
  owner: string,
) {
  const row = laterTargetStatement(db).get(target, owner);
  return row === undefined
    ? undefined
    : parseRecord(laterTargetRow, row, "artifacts");
}

const attachmentDescriptorsStatement = statement(
  "SELECT a.id,o.id objectId,o.name,o.mime,length(o.bytes) size FROM artifacts a\n      JOIN objects o ON o.id=json_extract(a.metadata,'$.objectId') AND o.owner_id=a.owner_id\n      WHERE a.owner_id=? AND json_extract(a.metadata,'$.upload') IS NOT NULL AND a.id IN (SELECT value FROM json_each(?))",
);
const attachmentDescriptorsRow = z.object({
  id: z.string(),
  objectId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
});
export function attachmentDescriptors(
  db: Database.Database,
  owner: string,
  ids: string,
) {
  return attachmentDescriptorsStatement(db)
    .all(owner, ids)
    .map((row) => parseRecord(attachmentDescriptorsRow, row, "artifacts"));
}

const ownedAgentFileExistsStatement = statement(
  "SELECT 1 FROM artifacts a JOIN artifact_objects f ON f.artifact_id=a.id AND f.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.agent_id=?",
);
const ownedAgentFileExistsRow = z.object({ "1": z.number() });
export function ownedAgentFileExists(
  db: Database.Database,
  file: string,
  owner: string,
  agent: string | null,
) {
  const row = ownedAgentFileExistsStatement(db).get(file, owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(ownedAgentFileExistsRow, row, "artifacts");
}

const pinnedStatement = statement(
  "SELECT pinned FROM artifacts WHERE id=? AND owner_id=?",
);
const pinnedRow = QueryRecords.artifacts.pick({ pinned: true });
export function pinned(db: Database.Database, id: string, owner: string) {
  const row = pinnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(pinnedRow, row, "artifacts");
}

const memoryCandidatesStatement = statement(
  "SELECT * FROM artifacts WHERE pinned=1 OR id IN (SELECT substr(scope,10) FROM memory_policy WHERE scope LIKE 'artifact:%' AND enabled=1)",
);
const memoryCandidatesRow = QueryRecords.artifacts;
export function memoryCandidates(db: Database.Database) {
  return memoryCandidatesStatement(db)
    .all()
    .map((row) => parseRecord(memoryCandidatesRow, row, "artifacts"));
}

const moveStatement = statement(
  "UPDATE artifacts SET folder_id=?,version=version+1,updated_at=? WHERE id=?",
);
export function move(
  db: Database.Database,
  folder: string | null,
  updated: number,
  id: string,
) {
  return moveStatement(db).run(folder, updated, id);
}

const conversationHasArtifactStatement = statement(
  "SELECT 1 FROM artifacts WHERE owner_id=? AND conversation_id=?",
);
const conversationHasArtifactRow = z.object({ "1": z.number() });
export function conversationHasArtifact(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  const row = conversationHasArtifactStatement(db).get(owner, conversation);
  return row === undefined
    ? undefined
    : parseRecord(conversationHasArtifactRow, row, "artifacts");
}

const updateNativeOutputStatement = statement(
  "UPDATE artifacts SET content=?,metadata=?,updated_at=? WHERE id=? AND version=1",
);
export function updateNativeOutput(
  db: Database.Database,
  content: string,
  metadata: string,
  updated: number,
  id: string,
) {
  return updateNativeOutputStatement(db).run(content, metadata, updated, id);
}
