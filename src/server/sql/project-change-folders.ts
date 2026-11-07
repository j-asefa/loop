import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const forProjectStatement = statement(
  "SELECT folder_id FROM project_change_folders WHERE owner_id=? AND project_id=?",
);
const forProjectRow = QueryRecords.project_change_folders.pick({
  folder_id: true,
});
export function forProject(
  db: Database.Database,
  owner: string,
  project: string,
) {
  return forProjectStatement(db)
    .all(owner, project)
    .map((row) => parseRecord(forProjectRow, row, "project_change_folders"));
}
