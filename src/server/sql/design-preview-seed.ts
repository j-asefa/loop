import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsStatement = statement(
  "SELECT 1 FROM design_preview_seed WHERE version=1",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database) {
  const row = existsStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "design_preview_seed");
}

const insertStatement = statement("INSERT INTO design_preview_seed VALUES(1)");
export function insert(db: Database.Database) {
  return insertStatement(db).run();
}

export function initialize(db: Database.Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS design_preview_seed(version INTEGER PRIMARY KEY)",
  );
}
