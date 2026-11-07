import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const phrasesStatement = statement(
  "SELECT phrase FROM feed_mutes WHERE owner_id=? ORDER BY created_at",
);
const phrasesRow = QueryRecords.feed_mutes.pick({ phrase: true });
export function phrases(db: Database.Database, owner: string) {
  return phrasesStatement(db)
    .all(owner)
    .map((row) => parseRecord(phrasesRow, row, "feed_mutes"));
}

const insertStatement = statement(
  "INSERT OR IGNORE INTO feed_mutes(owner_id,phrase,created_at) VALUES(?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  phrase: string,
  at: number,
) {
  return insertStatement(db).run(owner, phrase, at);
}

const removeStatement = statement(
  "DELETE FROM feed_mutes WHERE owner_id=? AND phrase=?",
);
export function remove(db: Database.Database, owner: string, phrase: string) {
  return removeStatement(db).run(owner, phrase);
}
