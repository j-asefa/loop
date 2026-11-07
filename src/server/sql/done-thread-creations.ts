import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownerStatement = statement(
  "SELECT owner_id FROM done_thread_creations WHERE id=?",
);
const ownerRow = QueryRecords.done_thread_creations.pick({ owner_id: true });
export function owner(db: Database.Database, id: string) {
  const row = ownerStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(ownerRow, row, "done_thread_creations");
}

const insertStatement = statement(
  "INSERT INTO done_thread_creations(id,owner_id) VALUES(?,?)",
);
export function insert(db: Database.Database, id: string, owner: string) {
  return insertStatement(db).run(id, owner);
}
