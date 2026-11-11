import type { CardSelection } from "../../shared/cards.js";
import { FOLDER_PROJECT } from "./folders.js";
import {
  ArtifactKindSchema,
  type ArtifactKind,
} from "../../shared/artifact-kind.js";
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
  "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,folder_id,created_at,updated_at) VALUES(@id,@owner,@agent,@conversation,@run,@title,@kind,@content,@metadata,@folder,@created,@created)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string | null,
  conversation: string | null,
  run: string | null,
  title: string,
  kind: ArtifactKind,
  content: string,
  metadata: string,
  folder: string | null,
  created: number,
) {
  return insertStatement(db).run({
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
  });
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
const finishedArtifactSql = `(a.run_id IS NULL OR r.state='completed')`;
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
    where += ` AND ${fileArtifactSql} AND a.kind IN ('file','image','table','diagram','chart')`;
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
  "UPDATE artifacts SET pinned=@pinned,version=version+1,updated_at=@updated WHERE id=@artifact AND owner_id=@owner AND pinned<>@pinned",
);
export function bookmark(
  db: Database.Database,
  pinned: number,
  updated: number,
  artifact: string,
  owner: string,
) {
  return bookmarkStatement(db).run({ pinned, updated, artifact, owner });
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

export function memoryCandidates(db: Database.Database) {
  return memoryCandidatesStatement(db)
    .all()
    .map((row) => parseRecord(QueryRecords.artifacts, row, "artifacts"));
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

const runFilesStatement = statement(
  "SELECT a.id,a.title,a.metadata FROM artifacts a JOIN artifact_objects f ON f.artifact_id=a.id AND f.owner_id=a.owner_id WHERE a.owner_id=? AND a.run_id=? AND a.archived=0 ORDER BY a.created_at,a.rowid",
);
const runFilesRow = QueryRecords.artifacts.pick({
  id: true,
  title: true,
  metadata: true,
});
export function runFiles(db: Database.Database, owner: string, run: string) {
  return runFilesStatement(db)
    .all(owner, run)
    .map((row) => parseRecord(runFilesRow, row, "artifacts"));
}

const editStatement = statement(
  "UPDATE artifacts SET title=?,content=?,pinned=?,archived=?,version=version+1,updated_at=? WHERE id=?",
);
export function edit(
  db: Database.Database,
  title: string,
  content: string,
  pinned: number,
  archived: number,
  time: number,
  id: string,
) {
  return editStatement(db).run(title, content, pinned, archived, time, id);
}

const markEditedStatement = statement(
  "UPDATE artifacts SET metadata=json_set(metadata,'$.partial',json('false'),'$.edited',json('true')) WHERE id=?",
);
export function markEdited(db: Database.Database, id: string) {
  return markEditedStatement(db).run(id);
}

const workspaceListStatements = statementVariants();
const workspaceListRow = QueryRecords.artifacts.extend({
  cursor: z.number(),
  name: z.string().nullable(),
  provider: z.string().nullable(),
});
export function workspaceList(
  db: Database.Database,
  owner: string,
  options: {
    folder?: string;
    workspace: boolean;
    agent?: string;
    pinned: boolean;
    before?: number;
  },
) {
  let where = "a.owner_id=? AND a.archived=0";
  const args: unknown[] = [owner];
  if (options.folder === "unfiled") where += " AND a.folder_id IS NULL";
  else if (options.folder) {
    where += options.workspace
      ? " AND (a.folder_id=? OR a.folder_id IS NULL)"
      : " AND a.folder_id=?";
    args.push(options.folder);
  }
  if (options.pinned) where += " AND a.pinned=1";
  if (options.agent) {
    where += " AND a.agent_id=?";
    args.push(options.agent);
  }
  if (options.before !== undefined) {
    where += " AND a.rowid<?";
    args.push(options.before);
  }
  return workspaceListStatements(
    "SELECT a.*,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,a.rowid AS cursor,g.name,g.provider FROM artifacts a LEFT JOIN agents g ON g.id=a.agent_id WHERE " +
      where +
      " ORDER BY a.rowid DESC LIMIT 60",
    db,
  )
    .all(...args)
    .map((row) => parseRecord(workspaceListRow, row, "artifacts"));
}

const pullReferencesStatement = statement(
  "SELECT content,created_at FROM artifacts WHERE owner_id=? AND conversation_id=? AND kind='github_pr' ORDER BY created_at DESC,rowid DESC",
);

export function* pullReferences(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  for (const row of pullReferencesStatement(db).iterate(owner, conversation))
    yield parseRecord(
      QueryRecords.artifacts.pick({ content: true, created_at: true }),
      row,
      "artifacts",
    );
}

const attachmentAuthorityStatement = statement(
  "SELECT a.id,\n      (SELECT o.id FROM objects o WHERE o.owner_id=a.owner_id AND o.id=json_extract(a.metadata,'$.objectId')) object_id,\n      EXISTS(SELECT 1 FROM artifact_objects ao WHERE ao.artifact_id=a.id AND ao.owner_id=a.owner_id) published\n      FROM artifacts a WHERE a.id=? AND a.owner_id=?",
);
const attachmentAuthorityRow = QueryRecords.artifacts
  .pick({ id: true })
  .extend({ object_id: z.string().nullable(), published: z.number() });
export function attachmentAuthority(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = attachmentAuthorityStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(attachmentAuthorityRow, row, "artifacts");
}

export type CardQuerySelection = CardSelection & {
  teamIds: string[];
  folders: (string | null)[] | null;
};
export const cardRow = z.object({
  id: z.string(),
  owner_id: z.string(),
  content: z.string(),
  metadata: z.string(),
  created_at: z.number(),
  updated_at: z.number().nullable(),
  title: z.string().nullable(),
  kind: ArtifactKindSchema.nullable(),
  version: z.number().nullable(),
  role: z.string().nullable(),
  conversation_id: z.string().nullable(),
  conversation_title: z.string().nullable(),
  run_id: z.string().nullable(),
  folder_id: z.string().nullable(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  team_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  provider: z.string().nullable(),
  personal: z.number(),
  saved: z.number(),
  feed_hidden: z.number(),
  order_at: z.number(),
  key: z.string(),
  saved_at: z.number().nullable(),
  label: z.string().nullable(),
});
export type CardQueryRow = z.infer<typeof cardRow>;
const resultCardSql = `a.archived=0 AND a.feed_hidden=0 AND p.sequence IS NOT NULL AND COALESCE(json_extract(a.metadata,'$.snippet'),0) IN (0,'') AND ${resultOutputSql}`;
const savedResultCardSql = `a.archived=0 AND a.pinned=1 AND b.sequence IS NOT NULL
  AND ${fileArtifactSql} AND json_extract(a.metadata,'$.snippet') IS NULL`;

const cardsStatement = statementVariants();
const projects = `WITH card_projects(folder_id,project_id) AS (
  SELECT folder_id,project_id FROM project_change_folders WHERE owner_id=@owner
)`;

export function cards(
  db: Database.Database,
  owner: string,
  options: CardQuerySelection,
  {
    ids,
    before,
    limit = 100,
  }: { ids?: string[]; before?: [number, string] | null; limit?: number } = {},
) {
  if (ids && !ids.length) return [];
  if (options.view === "sent") return [];
  const folder = "a.folder_id";
  const agent = "a.agent_id";
  const filterAgent = agent;
  const source = "a";
  const key = `'a:'||${source}.id`;
  const at =
    options.view === "saved"
      ? "COALESCE(b.saved_at,a.updated_at)"
      : "p.sequence";
  const predicate =
    options.view === "saved" ? savedResultCardSql : resultCardSql;
  const search =
    "(instr(card_lower(a.content),card_lower(@q))>0 OR instr(card_lower(a.title),card_lower(@q))>0 OR instr(card_lower(l.label),card_lower(@q))>0)";
  return cardsStatement(
    `${projects}
    SELECT ${source}.id,${source}.owner_id,${source}.content,${source}.metadata,${source}.created_at,
      a.updated_at,a.title,a.kind,a.version,NULL role,
      c.id conversation_id,c.title conversation_title,r.id run_id,${folder} folder_id,
      project.id project_id,project.name project_name,c.team_id,
      g.id agent_id,g.name agent_name,g.provider,
      0 personal,a.pinned saved,a.feed_hidden,
      ${at} order_at,${key} key,
      CASE WHEN a.pinned=1 THEN COALESCE(b.saved_at,a.updated_at) END saved_at,l.label
    FROM artifacts a
    LEFT JOIN conversations c ON c.id=${source}.conversation_id AND c.owner_id=${source}.owner_id
    LEFT JOIN runs r ON r.id=${source}.run_id AND r.owner_id=${source}.owner_id
    LEFT JOIN agents g ON g.id=(${agent}) AND g.owner_id=${source}.owner_id
    LEFT JOIN artifact_publications p ON p.artifact_id=a.id LEFT JOIN artifact_bookmarks b ON b.artifact_id=a.id
    LEFT JOIN saved_labels l ON l.owner_id=${source}.owner_id AND l.item_key=${key}
    LEFT JOIN card_projects fp ON fp.folder_id IS ${folder}
    LEFT JOIN folders project ON project.id=fp.project_id AND project.owner_id=${source}.owner_id
    WHERE ${source}.owner_id=@owner AND (${source}.conversation_id IS NULL OR c.id IS NOT NULL)
      AND (${predicate})
      ${ids ? `AND ${source}.id IN (SELECT value FROM json_each(@ids))` : ""}
      AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS ${folder}))
      AND (@agent IS NULL OR (${filterAgent})=@agent)
      AND (@teams IS NULL OR c.team_id IN (SELECT value FROM json_each(@teams)))
      AND (@q IS NULL OR ${search})
      AND (@at IS NULL OR (${at},${key})<(@at,@key))
    ORDER BY ${at} DESC,${key} DESC LIMIT @limit`,
    db,
  )
    .all({
      owner,
      ids: ids ? JSON.stringify(ids) : null,
      folders: options.folders ? JSON.stringify(options.folders) : null,
      agent: options.agent || null,
      teams: options.teamIds.length ? JSON.stringify(options.teamIds) : null,
      q: options.q || null,
      at: before?.[0] ?? null,
      key: before?.[1] ?? null,
      limit,
    })
    .map((row) => parseRecord(cardRow, row, "artifacts"));
}

const representedSearchMessagesStatement = statement(
  "SELECT 'message:'||m.id AS id FROM artifacts a\n      JOIN messages m ON (m.id=json_extract(a.metadata,'$.messageId') OR (a.run_id IS NOT NULL AND m.run_id=a.run_id))\n        AND m.owner_id=a.owner_id AND m.conversation_id=a.conversation_id\n        AND m.role='assistant' AND json_extract(m.metadata,'$.progress') IS NOT 1 AND trim(replace(m.content,char(13),''))=trim(replace(a.content,char(13),''))\n      WHERE a.owner_id=? AND a.id IN (SELECT value FROM json_each(?))",
);
const representedSearchMessagesRow = z.object({ id: z.string() });
export function representedSearchMessages(
  db: Database.Database,
  owner: string,
  ids: string,
) {
  return representedSearchMessagesStatement(db)
    .all(owner, ids)
    .map((row) => parseRecord(representedSearchMessagesRow, row, "artifacts"));
}

const searchMessageStatement = statement(
  "SELECT m.id AS message_id FROM artifacts a\n                 JOIN messages m ON (m.id=json_extract(a.metadata,'$.messageId') OR (a.run_id IS NOT NULL AND m.run_id=a.run_id))\n                   AND m.owner_id=a.owner_id AND m.conversation_id=a.conversation_id\n                   AND m.role='assistant' AND json_extract(m.metadata,'$.progress') IS NOT 1 AND trim(replace(m.content,char(13),''))=trim(replace(a.content,char(13),''))\n                 WHERE a.id=? AND a.owner_id=?",
);
const searchMessageRow = z.object({ message_id: z.string() });
export function searchMessage(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = searchMessageStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(searchMessageRow, row, "artifacts");
}
