import { z } from "zod";
import type Database from "better-sqlite3";
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
const getRow = QueryRecords.memory_sources;
export function get(db: Database.Database, id: string) {
  const row = getStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "memory_sources");
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

const inConversationStatement = statement(
  "SELECT 1 FROM memory_sources WHERE id=? AND conversation_id=?",
);
const inConversationRow = z.object({ "1": z.number() });
export function inConversation(
  db: Database.Database,
  id: string,
  conversation: string | null,
) {
  const row = inConversationStatement(db).get(id, conversation);
  return row === undefined
    ? undefined
    : parseRecord(inConversationRow, row, "memory_sources");
}

const summariesStatement = statement(
  "SELECT id,title,kind,project_id,revision,eligible,tombstone FROM memory_sources WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100",
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
const forOwnerRow = QueryRecords.memory_sources;
export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(forOwnerRow, row, "memory_sources"));
}

const advanceRevisionStatement = statement(
  "UPDATE memory_sources SET revision=revision+1,updated_at=? WHERE id=?",
);
export function advanceRevision(
  db: Database.Database,
  updated: number,
  id: string,
) {
  return advanceRevisionStatement(db).run(updated, id);
}

const tombstoneStatement = statement(
  "UPDATE memory_sources SET tombstone=1,eligible=0,revision=revision+1 WHERE id=?",
);
export function tombstone(db: Database.Database, id: string) {
  return tombstoneStatement(db).run(id);
}
