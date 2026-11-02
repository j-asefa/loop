import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT INTO workflow_versions VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  workflow: string,
  version: number,
  source: string,
  compiled: string,
  created: number,
) {
  return insertStatement(db).run(workflow, version, source, compiled, created);
}

const historyStatement = statement(
  "SELECT version,source,created_at FROM workflow_versions WHERE workflow_id=? ORDER BY version DESC",
);
const historyRow = QueryRecords.workflow_versions.pick({
  version: true,
  source: true,
  created_at: true,
});
export function history(db: Database.Database, workflow: string) {
  return historyStatement(db)
    .all(workflow)
    .map((row) => parseRecord(historyRow, row, "workflow_versions"));
}

const versionStatement = statement(
  "SELECT * FROM workflow_versions WHERE workflow_id=? AND version=?",
);
const versionRow = QueryRecords.workflow_versions;
export function version(
  db: Database.Database,
  workflow: string,
  version: number,
) {
  const row = versionStatement(db).get(workflow, version);
  return row === undefined
    ? undefined
    : parseRecord(versionRow, row, "workflow_versions");
}
