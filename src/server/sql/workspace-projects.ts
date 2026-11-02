import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsStatement = statement(
  "SELECT 1 FROM workspace_projects WHERE owner_id=? AND project_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, owner: string, project: string) {
  const row = existsStatement(db).get(owner, project);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "workspace_projects");
}

const forOwnerStatement = statement(
  "SELECT project_id FROM workspace_projects WHERE owner_id=?",
);
const forOwnerRow = QueryRecords.workspace_projects.pick({ project_id: true });
export function forOwner(db: Database.Database, owner: string) {
  const row = forOwnerStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(forOwnerRow, row, "workspace_projects");
}

const insertStatement = statement(
  "INSERT INTO workspace_projects(owner_id,project_id) VALUES(?,?)",
);
export function insert(db: Database.Database, owner: string, project: string) {
  return insertStatement(db).run(owner, project);
}
