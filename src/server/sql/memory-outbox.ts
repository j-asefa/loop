import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const enqueueResetAttemptsStatement = statement(
  "INSERT INTO memory_outbox(source_id,revision,action) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,action=excluded.action,attempts=0,next_attempt=0",
);
export function enqueueResetAttempts(
  db: Database.Database,
  source: string,
  revision: number,
  action: string,
) {
  return enqueueResetAttemptsStatement(db).run(source, revision, action);
}

const dueStatement = statement(
  "SELECT * FROM memory_outbox WHERE next_attempt<=? LIMIT 8",
);
const dueRow = QueryRecords.memory_outbox;
export function due(db: Database.Database, time: number) {
  return dueStatement(db)
    .all(time)
    .map((row) => parseRecord(dueRow, row, "memory_outbox"));
}

const removeRevisionStatement = statement(
  "DELETE FROM memory_outbox WHERE source_id=? AND revision=?",
);
export function removeRevision(
  db: Database.Database,
  source: string,
  revision: number,
) {
  return removeRevisionStatement(db).run(source, revision);
}

const backoffStatement = statement(
  "UPDATE memory_outbox SET attempts=attempts+1,next_attempt=? WHERE source_id=? AND revision=?",
);
export function backoff(
  db: Database.Database,
  next: number,
  source: string,
  revision: number,
) {
  return backoffStatement(db).run(next, source, revision);
}

const ownedCountStatement = statement(
  "SELECT count(*) n FROM memory_outbox o JOIN memory_sources s ON s.id=o.source_id WHERE s.owner_id=?",
);
const ownedCountRow = z.object({ n: z.number() });
export function ownedCount(db: Database.Database, owner: string) {
  const row = ownedCountStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedCountRow, row, "memory_outbox");
}

const enqueueStatement = statement(
  "INSERT INTO memory_outbox(source_id,revision,action) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,action=excluded.action,next_attempt=0",
);
export function enqueue(
  db: Database.Database,
  source: string,
  revision: number,
  action: string,
) {
  return enqueueStatement(db).run(source, revision, action);
}

const enqueueDeleteStatement = statement(
  "INSERT INTO memory_outbox(source_id,revision,action) VALUES(?,?,'delete') ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,action='delete',next_attempt=0",
);
export function enqueueDelete(
  db: Database.Database,
  source: string,
  revision: number,
) {
  return enqueueDeleteStatement(db).run(source, revision);
}
