import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT INTO memory_note_versions VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  source: string,
  revision: number,
  title: string,
  content: string,
  created: number,
) {
  return insertStatement(db).run(source, revision, title, content, created);
}

const historyStatement = statement(
  "SELECT revision,title,content,created_at FROM memory_note_versions WHERE source_id=? ORDER BY revision DESC",
);
const historyRow = QueryRecords.memory_note_versions.omit({ source_id: true });
export function history(db: Database.Database, source: string) {
  return historyStatement(db)
    .all(source)
    .map((row) => parseRecord(historyRow, row, "memory_note_versions"));
}
