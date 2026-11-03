import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Cancellation needs ownership, not valid display or restart fields.
const existsOwnedStatement = statement(
  "SELECT 1 FROM imports WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(db: Database.Database, id: string, owner: string) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "imports");
}

const ownedStatement = statement(
  "SELECT * FROM imports WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.imports, row, "imports");
}

const byDigestStatement = statement(
  "SELECT * FROM imports WHERE owner_id=? AND digest=?",
);
const byDigestRow = QueryRecords.imports;
export function byDigest(db: Database.Database, owner: string, digest: string) {
  const row = byDigestStatement(db).get(owner, digest);
  return row === undefined
    ? undefined
    : parseRecord(byDigestRow, row, "imports");
}

const insertPreviewStatement = statement(
  "INSERT INTO imports VALUES(?,?,?,?,'preview',?,?)",
);
export function insertPreview(
  db: Database.Database,
  id: string,
  owner: string,
  provider: string,
  digest: string,
  summary: string,
  created: number,
) {
  return insertPreviewStatement(db).run(
    id,
    owner,
    provider,
    digest,
    summary,
    created,
  );
}

const markRunningStatement = statement(
  "UPDATE imports SET status='running' WHERE id=?",
);
export function markRunning(db: Database.Database, id: string) {
  return markRunningStatement(db).run(id);
}

const setSummaryStatement = statement(
  "UPDATE imports SET summary=? WHERE id=?",
);
export function setSummary(db: Database.Database, summary: string, id: string) {
  return setSummaryStatement(db).run(summary, id);
}

const markPausedStatement = statement(
  "UPDATE imports SET status='paused' WHERE id=?",
);
export function markPaused(db: Database.Database, id: string) {
  return markPausedStatement(db).run(id);
}

const markCancelledStatement = statement(
  "UPDATE imports SET status='cancelled' WHERE id=?",
);
export function markCancelled(db: Database.Database, id: string) {
  return markCancelledStatement(db).run(id);
}

const markCompletedStatement = statement(
  "UPDATE imports SET status='completed' WHERE id=?",
);
export function markCompleted(db: Database.Database, id: string) {
  return markCompletedStatement(db).run(id);
}

const failOwnedStatement = statement(
  "UPDATE imports SET status='failed' WHERE id=? AND owner_id=?",
);
export function failOwned(
  db: Database.Database,
  id: string | undefined,
  owner: string,
) {
  return failOwnedStatement(db).run(id, owner);
}

const forOwnerStatement = statement(
  "SELECT * FROM imports WHERE owner_id=? ORDER BY created_at DESC LIMIT 100",
);
const forOwnerRow = QueryRecords.imports;
export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(forOwnerRow, row, "imports"));
}

const queueStatement = statement(
  "UPDATE imports SET status='queued' WHERE id=?",
);
export function queue(db: Database.Database, id: string) {
  return queueStatement(db).run(id);
}

const cancelStatement = statement(
  "UPDATE imports SET status='cancelled' WHERE id=? AND status<>'completed'",
);
export function cancel(db: Database.Database, id: string) {
  return cancelStatement(db).run(id);
}
