import type { CardSelection } from "../../shared/cards.js";
import { FOLDER_PROJECT } from "./folders.js";
import {
  ArtifactKindSchema,
  type ArtifactKind,
} from "../../shared/artifact-kind.js";
import {
  ArtifactRoleSchema,
  ResultArtifactRoles,
  type ArtifactRole,
} from "../../shared/artifact-role.js";

// The result role set as an IN-list, built from the one shared constant (D3)
// so SQL and TypeScript cannot drift.
const resultRolesSql = ResultArtifactRoles.map((r) => `'${r}'`).join(",");
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
  "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,role,content,metadata,folder_id,created_at,updated_at) VALUES(@id,@owner,@agent,@conversation,@run,@title,@kind,@role,@content,@metadata,@folder,@created,@created)",
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
  role: ArtifactRole,
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
    role,
    content,
    metadata,
    folder,
    created,
  });
}

// Artifacts that are never standalone outputs (D3): tool and native capture
// rows are traces; a native answer is still trace-like until its done
// checkpoint holds content (lifecycle, the row's role stays `answer`); and any
// artifact of a run whose checkpoint points at a different artifact (a
// published run file, for example) stays out of the search index like the
// pre-role filter did. The answer's own checkpoint points at itself, so the
// third clause never classifies the answer.
export const traceArtifactSql = `(a.role='trace'
  OR (a.role='answer' AND json_extract(a.metadata,'$.native')=1 AND NOT EXISTS(
    SELECT 1 FROM agent_checkpoints cp WHERE cp.run_id=a.run_id
      AND cp.artifact_id=a.id AND cp.stage='done' AND length(trim(a.content))>0))
  OR EXISTS(SELECT 1 FROM agent_checkpoints cp WHERE cp.run_id=a.run_id
    AND cp.artifact_id<>a.id))`;
const finishedArtifactSql = `(a.run_id IS NULL OR r.state='completed')`;
// Files are published artifacts; the Files/Saved views also show every
// finished artifact regardless of role (the run state gates answers).
export const fileArtifactSql = `(${finishedArtifactSql} OR a.role='file')`;
// What counts as a result (D3): the shared ResultArtifactRoles, once the run
// is finished. trace/file/upload rows are never results; the run state gates
// answers, and the native lifecycle clause keeps an answer out until its done
// checkpoint holds content even if the run row already says completed. The
// `partial` probe is gone: completion rewrites it away, so the clause
// selected nothing extra outside that unreachable row (D4, equivalence-tested).
export const resultOutputSql = `(a.role IN (${resultRolesSql}) AND ${finishedArtifactSql}
  AND NOT COALESCE(${traceArtifactSql},0))`;

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
  "SELECT a.id,o.id objectId,o.name,o.mime,length(o.bytes) size FROM artifacts a\n      JOIN objects o ON o.id=json_extract(a.metadata,'$.objectId') AND o.owner_id=a.owner_id\n      WHERE a.owner_id=? AND a.role='upload' AND a.id IN (SELECT value FROM json_each(?))",
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

/**
 * Whether a run's prompts were all written by its owner: every user message of
 * the run (its first prompt and anything steered in later) is a personal send
 * without shared outside text or an integration token, and the run is not a
 * snapshot review. Agent mail, watched pull requests and digests are not
 * personal. Always 0 or 1. Shared text earlier in the conversation is checked
 * at recall time (hasUnwrittenMessage), not in the capture scan, where it cost
 * about 0.8 s per full pass on a live workspace.
 */
export const personalRunSql = (run: string, owner: string) =>
  `(EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=${owner} AND m.run_id=${run} AND m.role='user')
  AND NOT EXISTS(SELECT 1 FROM messages sm WHERE sm.owner_id=${owner} AND sm.run_id=${run}
    AND sm.role='user' AND (COALESCE(json_extract(sm.metadata,'$.personal'),0)<>1
      OR COALESCE(json_extract(sm.metadata,'$.shared'),0)=1))
  AND NOT EXISTS(SELECT 1 FROM runs pr WHERE pr.id=${run} AND pr.owner_id=${owner}
    AND json_extract(pr.payload,'$.reviewId') IS NOT NULL))`;
// A published result is in memory by default only when it is a finished
// answer by the feed's own rule (resultOutputSql) to a prompt its owner typed:
// tool output, files and traces are published too but are not results, and an
// automation run's answer may restate third-party text. Pinned or explicitly
// included artifacts may be any text.
// The cheap clauses come before resultOutputSql's correlated checkpoint lookups.
const personalPublishedSql = `(EXISTS(SELECT 1 FROM artifact_publications p WHERE p.artifact_id=a.id)
  AND (a.run_id IS NULL OR (${personalRunSql("a.run_id", "a.owner_id")})))`;
export const publishedResultSql = `COALESCE((${personalPublishedSql} AND ${resultOutputSql}),0)`;

// What decides whether an artifact is in memory by default, read again at
// recall time: pinned or a published result, unless archived.
const memoryDefaultStatement = statement(
  `SELECT a.pinned,a.archived,a.conversation_id,a.folder_id,a.created_at,${publishedResultSql} AS result,
      (a.title=@title AND a.content=@content) AS current
    FROM artifacts a LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    WHERE a.id=@id AND a.owner_id=@owner`,
);
const memoryDefaultRow = QueryRecords.artifacts
  .pick({
    pinned: true,
    archived: true,
    conversation_id: true,
    folder_id: true,
    created_at: true,
  })
  .extend({ result: z.number(), current: z.number() });
/**
 * An artifact's live memory state. `current` says whether its saved memory
 * copy (`saved`) still matches its title and content.
 */
export function memoryDefault(
  db: Database.Database,
  id: string,
  owner: string,
  saved: { title: string; content: string },
) {
  const row = memoryDefaultStatement(db).get({ id, owner, ...saved });
  return row === undefined
    ? undefined
    : parseRecord(memoryDefaultRow, row, "artifacts");
}

const memoryResultEvidenceStatement = statement(
  `SELECT r.id AS result_id, r.content_digest,
          @content IS NOT json_extract(r.outcome,'$.body') AS edited,
          k.source AS checkout_source, k.branch AS checkout_branch,
          k.end_head AS checkout_commit
     FROM artifacts a
     JOIN results r ON r.owner_id=a.owner_id AND r.id='run:'||a.run_id
       AND r.sealed=1 AND r.conversation_id=a.conversation_id
     LEFT JOIN agent_checkpoints cp ON cp.run_id=a.run_id
     LEFT JOIN run_checkouts k ON k.owner_id=a.owner_id AND k.run_id=a.run_id
     WHERE a.id=@id AND a.owner_id=@owner AND a.role='answer'
       AND (json_extract(a.metadata,'$.messageId')=r.message_id OR
         (json_extract(a.metadata,'$.messageId') IS NULL AND
           ((cp.artifact_id=a.id AND cp.message_id=r.message_id) OR
             @content=json_extract(r.outcome,'$.body'))))`,
);
const memoryResultEvidenceRow = z.object({
  result_id: z.string(),
  content_digest: z.string().regex(/^[0-9a-f]{64}$/),
  edited: z.number(),
  checkout_source: z.string().nullable(),
  checkout_branch: z.string().nullable(),
  checkout_commit: z.string().nullable(),
});
/** Project sealed evidence without loading attachments or result lineage. */
export function memoryResultEvidence(
  db: Database.Database,
  id: string,
  owner: string,
  content: string,
) {
  const row = memoryResultEvidenceStatement(db).get({ id, owner, content });
  return row === undefined
    ? undefined
    : parseRecord(memoryResultEvidenceRow, row, "artifacts");
}

export const MEMORY_CANDIDATE_BATCH = 250;
// The cheap already-captured check comes first: once memory has caught up it
// rejects almost every row before the result clause's correlated lookups.
// Unarchived text artifacts that are published results, pinned or explicitly
// included, and whose saved memory copy is missing or differs. A source the
// owner deleted from memory is never recaptured.
export const memoryCandidatesSql = `SELECT a.* FROM artifacts a
  LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
  WHERE (a.updated_at>=@since OR r.updated_at>=@since) AND a.kind IN ('markdown','note','text') AND a.archived=0
  AND NOT EXISTS(SELECT 1 FROM memory_sources s WHERE s.kind='artifact' AND s.source_id=a.id AND s.owner_id=a.owner_id
    AND (s.tombstone=1 OR (s.content=a.content AND s.title=a.title AND s.project_id IS a.folder_id)))
  AND (a.pinned=1 OR (${personalPublishedSql} AND COALESCE(${resultOutputSql},0))
    OR a.id IN (SELECT substr(scope,10) FROM memory_policy WHERE owner_id=a.owner_id AND scope LIKE 'artifact:%' AND enabled=1))
  LIMIT ${MEMORY_CANDIDATE_BATCH}`;
const memoryCandidatesStatement = statement(memoryCandidatesSql);

/** Candidates changed at or after `since` (0 rescans every artifact). */
export function memoryCandidates(db: Database.Database, since: number) {
  return memoryCandidatesStatement(db)
    .all({ since })
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
  "UPDATE artifacts SET metadata=json_set(metadata,'$.edited',json('true')) WHERE id=?",
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
  artifact_role: ArtifactRoleSchema.nullable(),
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
      a.updated_at,a.title,a.kind,a.role artifact_role,a.version,NULL role,
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
