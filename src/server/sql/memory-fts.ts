import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const searchStatement = statement(
  "SELECT s.id,s.revision FROM memory_fts f JOIN memory_sources s ON s.id=f.id WHERE memory_fts MATCH ? AND s.owner_id=? AND (s.project_id IS ? OR (s.kind='note' AND s.project_id IS NULL)) ORDER BY rank LIMIT 30",
);
const searchRow = QueryRecords.memory_sources.pick({
  id: true,
  revision: true,
});
export function search(
  db: Database.Database,
  match: string,
  owner: string,
  project: string | null,
) {
  return searchStatement(db)
    .all(match, owner, project)
    .map((row) => parseRecord(searchRow, row, "memory_fts"));
}
