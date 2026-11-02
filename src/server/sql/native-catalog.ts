import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const upsertCodexStatement = statement(
  "INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,?,?) ON CONFLICT(harness,native_id) DO UPDATE SET project=excluded.project,title=excluded.title,updated_at=excluded.updated_at",
);
export function upsertCodex(
  db: Database.Database,
  id: string,
  native: string,
  project: string,
  title: string,
  updated: number,
) {
  return upsertCodexStatement(db).run(id, native, project, title, updated);
}

const codexSummaryStatement = statement(
  "SELECT id,harness,project,title FROM native_catalog WHERE harness='codex' AND native_id=?",
);
const codexSummaryRow = QueryRecords.native_catalog.pick({
  id: true,
  harness: true,
  project: true,
  title: true,
});
export function codexSummary(db: Database.Database, native: string) {
  const row = codexSummaryStatement(db).get(native);
  return row === undefined
    ? undefined
    : parseRecord(codexSummaryRow, row, "native_catalog");
}

const getStatement = statement("SELECT * FROM native_catalog WHERE id=?");
const getRow = QueryRecords.native_catalog;
export function get(db: Database.Database, id: string) {
  const row = getStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "native_catalog");
}
