import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement("INSERT INTO project_paths VALUES(?,?)");
export function insert(db: Database.Database, folder: string, path: string) {
  return insertStatement(db).run(folder, path);
}

const pathStatement = statement(
  "SELECT path FROM project_paths WHERE folder_id=?",
);
const pathRow = QueryRecords.project_paths.pick({ path: true });
export function path(db: Database.Database, folder: string) {
  const row = pathStatement(db).get(folder);
  return row === undefined
    ? undefined
    : parseRecord(pathRow, row, "project_paths");
}

const allStatement = statement("SELECT * FROM project_paths");
const allRow = QueryRecords.project_paths;
export function all(db: Database.Database) {
  return allStatement(db)
    .all()
    .map((row) => parseRecord(allRow, row, "project_paths"));
}

const usedElsewhereStatement = statement(
  "SELECT 1 FROM project_paths WHERE path=? AND folder_id<>?",
);
const usedElsewhereRow = z.object({ "1": z.number() });
export function usedElsewhere(
  db: Database.Database,
  path: string,
  folder: string,
) {
  const row = usedElsewhereStatement(db).get(path, folder);
  return row === undefined
    ? undefined
    : parseRecord(usedElsewhereRow, row, "project_paths");
}

const upsertStatement = statement(
  "INSERT INTO project_paths VALUES(?,?) ON CONFLICT(folder_id) DO UPDATE SET path=excluded.path",
);
export function upsert(db: Database.Database, folder: string, path: string) {
  return upsertStatement(db).run(folder, path);
}
