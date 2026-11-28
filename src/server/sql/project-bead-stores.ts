import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const read = statement(
  "SELECT * FROM project_bead_stores WHERE owner_id=? AND project_id=?",
);
export function forProject(
  db: Database.Database,
  owner: string,
  project: string,
) {
  const row = read(db).get(owner, project);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.project_bead_stores, row, "project_bead_stores");
}

const insert = statement(
  "INSERT INTO project_bead_stores(owner_id,project_id,store_id) VALUES(?,?,?) ON CONFLICT(owner_id,project_id) DO NOTHING",
);
export function bind(
  db: Database.Database,
  owner: string,
  project: string,
  store: string,
) {
  insert(db).run(owner, project, store);
}
