import { publishedResultSql } from "./artifacts.js";
import { unwrittenMessageSql } from "./messages.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { personalRunSql, resultOutputSql } from "./artifacts.js";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
import { WORKSPACE_MCP_SERVER } from "../../shared/workspace-tools.js";

// Uses the current memory source alias s in the passage and document queries.
export const externalEvidenceSql = `EXISTS(
  SELECT 1 FROM runs r WHERE r.owner_id=s.owner_id
    AND r.id=CASE s.kind
      WHEN 'artifact' THEN (SELECT a.run_id FROM artifacts a WHERE a.id=s.source_id AND a.owner_id=s.owner_id AND a.role='answer')
      WHEN 'message' THEN (SELECT m.run_id FROM messages m WHERE m.id=s.source_id AND m.owner_id=s.owner_id AND m.role='assistant')
    END
    AND (
      EXISTS(SELECT 1 FROM native_calls n WHERE n.run_id=r.id
        AND n.tool='loop_feed' AND n.result IS NOT NULL)
      OR EXISTS(SELECT 1 FROM tool_invocations i WHERE i.run_id=r.id
        AND i.owner_id=r.owner_id AND i.connection_id<>'__loop__'
        AND i.state IN ('completed','failed') AND i.result IS NOT NULL)
      OR EXISTS(SELECT 1 FROM run_traces t WHERE t.run_id=r.id
        AND t.owner_id=r.owner_id AND t.kind='tool'
        AND (lower(replace(replace(t.title,'_',''),' ','')) IN
            ('websearch','webfetch','websearchexa','webfetchexa')
          OR (t.title GLOB 'mcp__*__*' AND t.title NOT GLOB 'mcp__${WORKSPACE_MCP_SERVER}__*')
          OR (t.title='mcpToolCall'
            AND json_extract(CASE WHEN json_valid(t.content) THEN t.content ELSE '{}' END,'$.server')
              NOT IN ('${WORKSPACE_MCP_SERVER}','__loop__'))))
    )
)`;

const externalEvidenceStatement = statement(
  `SELECT 1 FROM memory_sources s WHERE s.id=? AND s.owner_id=? AND ${externalEvidenceSql}`,
);
/** Recognize external content from recorded calls for this owner's answer. */
export function hasExternalEvidence(
  db: Database.Database,
  owner: string,
  source: string,
) {
  return externalEvidenceStatement(db).get(source, owner) !== undefined;
}

const ownedStatement = statement(
  "SELECT * FROM memory_sources WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.memory_sources, row, "memory_sources");
}

const getStatement = statement("SELECT * FROM memory_sources WHERE id=?");

export function get(db: Database.Database, id: string) {
  const row = getStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.memory_sources, row, "memory_sources");
}

const upsertStatement = statement(
  "INSERT INTO memory_sources(id,owner_id,project_id,kind,source_id,conversation_id,message_id,agent_id,origin,role,revision,content_hash,content,title,eligible,created_at,updated_at)\n    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,revision=excluded.revision,content_hash=excluded.content_hash,content=excluded.content,title=excluded.title,eligible=excluded.eligible,updated_at=excluded.updated_at",
);
export function upsert(
  db: Database.Database,
  id: string,
  owner: string,
  project: string | null,
  kind: string,
  source: string,
  conversation: string | null,
  message: string | null,
  agent: string | null,
  origin: string,
  role: string,
  revision: number,
  hash: string,
  content: string,
  title: string,
  eligible: number,
  created: number,
  updated: number,
) {
  return upsertStatement(db).run(
    id,
    owner,
    project,
    kind,
    source,
    conversation,
    message,
    agent,
    origin,
    role,
    revision,
    hash,
    content,
    title,
    eligible,
    created,
    updated,
  );
}

const setCompleteStatement = statement(
  "UPDATE memory_sources SET complete=? WHERE id=?",
);
export function setComplete(
  db: Database.Database,
  complete: number,
  id: string,
) {
  return setCompleteStatement(db).run(complete, id);
}

// Results are captured without a conversation, so match their artifact's.
export const inConversationSql = `(s.conversation_id IS @conversation OR
  (s.kind='artifact' AND EXISTS (
    SELECT 1 FROM artifacts a WHERE a.id=s.source_id AND a.owner_id=s.owner_id
      AND a.conversation_id=@conversation
  )))`;

const inConversationStatement = statement(
  `SELECT 1 AS found FROM memory_sources s WHERE s.id=@id AND @conversation IS NOT NULL AND ${inConversationSql}`,
);

export function inConversation(
  db: Database.Database,
  id: string,
  conversation: string | null,
) {
  return inConversationStatement(db).get({ id, conversation }) !== undefined;
}

const summariesStatement = statement(
  "SELECT id,title,kind,project_id,revision,eligible,tombstone FROM memory_sources WHERE owner_id=? ORDER BY kind='note' DESC,updated_at DESC LIMIT 100",
);
const summariesRow = QueryRecords.memory_sources.pick({
  id: true,
  title: true,
  kind: true,
  project_id: true,
  revision: true,
  eligible: true,
  tombstone: true,
});
export function summaries(db: Database.Database, owner: string) {
  return summariesStatement(db)
    .all(owner)
    .map((row) => parseRecord(summariesRow, row, "memory_sources"));
}

const forOwnerStatement = statement(
  "SELECT * FROM memory_sources WHERE owner_id=?",
);

export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) =>
      parseRecord(QueryRecords.memory_sources, row, "memory_sources"),
    );
}

const advanceRevisionStatement = statement(
  "UPDATE memory_sources SET revision=revision+1 WHERE id=?",
);
export function advanceRevision(db: Database.Database, id: string) {
  return advanceRevisionStatement(db).run(id);
}

const tombstoneStatement = statement(
  "UPDATE memory_sources SET tombstone=1,eligible=0,revision=revision+1 WHERE id=?",
);
export function tombstone(db: Database.Database, id: string) {
  return tombstoneStatement(db).run(id);
}

const captureProgressStatement = statement(
  "SELECT count(*) AS sources,COALESCE(sum(revision),0) AS revisions FROM memory_sources",
);
const captureProgressRow = z.object({
  sources: z.number(),
  revisions: z.number(),
});
/** Changes whenever a capture pass adds or revises a source. */
export function captureProgress(db: Database.Database) {
  return parseRecord(
    captureProgressRow,
    captureProgressStatement(db).get(),
    "memory_sources",
  );
}

// Captured records written before time-aware recall stored the capture time.
export const recallTimeSql = `CASE s.kind
  WHEN 'artifact' THEN COALESCE((SELECT a.updated_at FROM artifacts a
    WHERE a.id=s.source_id AND a.owner_id=s.owner_id), s.created_at)
  WHEN 'message' THEN s.created_at
  ELSE s.updated_at END`;

/** Filter live policies and conversation authorship before ranking pull candidates. */
export const conversationRecallEnabledSql = `(s.conversation_id IS NULL OR EXISTS (
  SELECT 1 FROM memory_policy mp
  WHERE mp.owner_id=s.owner_id AND mp.scope='conversation:' || s.conversation_id AND mp.enabled=1
)) AND (s.kind<>'artifact' OR NOT EXISTS (
  SELECT 1 FROM artifacts a
  LEFT JOIN memory_policy cp ON cp.owner_id=a.owner_id
    AND cp.scope='conversation:' || a.conversation_id AND cp.enabled=0
  LEFT JOIN memory_policy ap ON ap.owner_id=a.owner_id
    AND ap.scope='artifact:' || a.id
  WHERE a.id=s.source_id AND a.owner_id=s.owner_id
    AND (a.archived=1 OR ap.enabled=0 OR (ap.enabled IS NULL AND a.pinned=0 AND (
      cp.enabled=0 OR EXISTS (
        SELECT 1 FROM messages m WHERE m.conversation_id=a.conversation_id
          AND m.owner_id=a.owner_id AND m.created_at<=a.created_at
          AND ${unwrittenMessageSql}
      )
    )))
))`;

export const recallWindowSql = `(@from IS NULL OR ${recallTimeSql} >= @from)
  AND (@to IS NULL OR ${recallTimeSql} < @to)`;

const recallTimeStatement = statement(
  `SELECT ${recallTimeSql} AS updated_at FROM memory_sources s WHERE s.id=? AND s.owner_id=?`,
);
const recallTimeRow = QueryRecords.memory_sources.pick({ updated_at: true });
/** Source content timestamp, including records saved before date-aware recall. */
export function recallTime(db: Database.Database, id: string, owner: string) {
  const row = recallTimeStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(recallTimeRow, row, "memory_sources").updated_at;
}

// Replay evaluation (scripts/memory-recall-eval.ts) reads these on a copy of
// a workspace database; production recall never calls them.
const knownItemsStatement = statement(
  `SELECT s.id,s.owner_id,s.project_id,s.title,s.content,r.input,r.conversation_id FROM memory_sources s
    JOIN artifacts a ON a.id=s.source_id AND a.owner_id=s.owner_id
    JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    WHERE s.kind='artifact' AND s.tombstone=0 AND s.eligible=1
    AND EXISTS(SELECT 1 FROM artifact_publications p WHERE p.artifact_id=a.id)
    AND ${resultOutputSql}
    AND ${personalRunSql("r.id", "r.owner_id")}
    ORDER BY s.id`,
);
const knownItemsRow = QueryRecords.memory_sources
  .pick({
    id: true,
    owner_id: true,
    project_id: true,
    title: true,
    content: true,
  })
  .extend({ input: z.string(), conversation_id: z.string().nullable() });
/**
 * Saved results with the owner-typed prompt of the run that produced each: a
 * prompt whose own result recall should find (a known-item query).
 */
export function knownItems(db: Database.Database) {
  return knownItemsStatement(db)
    .all()
    .map((row) => parseRecord(knownItemsRow, row, "memory_sources"));
}

const promptsWithoutSourcesStatement = statement(
  `SELECT r.id AS run_id,r.owner_id,r.conversation_id,c.project_id,r.input FROM runs r
    JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
    WHERE ${personalRunSql("r.id", "r.owner_id")}
    AND NOT EXISTS(SELECT 1 FROM artifacts a JOIN memory_sources s ON s.kind='artifact'
      AND s.source_id=a.id AND s.owner_id=a.owner_id
      WHERE a.owner_id=r.owner_id AND a.conversation_id=r.conversation_id)
    ORDER BY r.id`,
);
const promptsWithoutSourcesRow = z.object({
  run_id: z.string(),
  owner_id: z.string(),
  conversation_id: z.string(),
  project_id: z.string().nullable(),
  input: z.string(),
});
/**
 * Owner-typed prompts from conversations that saved no result to memory.
 */
export function promptsWithoutSources(db: Database.Database) {
  return promptsWithoutSourcesStatement(db)
    .all()
    .map((row) => parseRecord(promptsWithoutSourcesRow, row, "runs"));
}

// The source stores artifacts separately from notes; result status is live.
export const evidenceKindSql = `CASE s.kind
  WHEN 'artifact' THEN CASE WHEN EXISTS (
    SELECT 1 FROM artifacts a LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    WHERE a.id=s.source_id AND a.owner_id=s.owner_id AND ${publishedResultSql}
  ) THEN 'result' ELSE 'note' END
  ELSE s.kind END`;
