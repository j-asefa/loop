import { evidenceKindSql, recallWindowSql } from "./memory-sources.js";
import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Filter the indexed owner before looking up the authoritative source row.
// The candidate bound keeps title and body matching within the recall budget.
const searchStatement = statement(
  `SELECT s.id,s.revision FROM memory_fts f JOIN memory_sources s ON s.id=f.id WHERE memory_fts MATCH @match AND f.owner_id=@owner AND s.owner_id=@owner AND (s.project_id IS @project OR (s.kind='note' AND s.project_id IS NULL)) AND NOT EXISTS (SELECT 1 FROM memory_passages p WHERE p.source_id=s.id AND p.ordinal=0 AND p.revision=s.revision) AND (@kind IS NULL OR ${evidenceKindSql}=@kind) AND ${recallWindowSql} ORDER BY rank LIMIT 75`,
);
const searchRow = QueryRecords.memory_sources.pick({
  id: true,
  revision: true,
});
/** Search document rows that do not yet have a passage index. */
export function searchPending(
  db: Database.Database,
  match: string,
  owner: string,
  project: string | null,
  kind: "result" | "note" | "message" | null = null,
  window?: { from: number | null; to: number | null },
) {
  return searchStatement(db)
    .all({
      owner,
      match,
      project,
      kind,
      from: window?.from ?? null,
      to: window?.to ?? null,
    })
    .map((row) => parseRecord(searchRow, row, "memory_fts"));
}
