import type Database from "better-sqlite3";
import { z } from "zod";
import { personalRunSql, resultOutputSql } from "./artifacts.js";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

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
const inConversationStatement = statement(
  "SELECT 1 AS found FROM memory_sources s WHERE s.id=@id AND (s.conversation_id=@conversation OR (s.kind='artifact' AND EXISTS(SELECT 1 FROM artifacts a WHERE a.id=s.source_id AND a.owner_id=s.owner_id AND a.conversation_id=@conversation)))",
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
