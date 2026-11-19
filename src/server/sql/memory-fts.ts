import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Filter the indexed owner before looking up the authoritative source row.
// The candidate bound keeps title and body matching within the recall budget.
const searchStatement = statement(
  "SELECT s.id,s.revision FROM memory_fts f JOIN memory_sources s ON s.id=f.id WHERE memory_fts MATCH @match AND f.owner_id=@owner AND s.owner_id=@owner AND (s.project_id IS @project OR (s.kind='note' AND s.project_id IS NULL)) ORDER BY rank LIMIT 75",
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
    .all({ owner, match, project })
    .map((row) => parseRecord(searchRow, row, "memory_fts"));
}
