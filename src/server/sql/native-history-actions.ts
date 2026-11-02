import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM native_history_actions WHERE id=?",
);
const getRow = QueryRecords.native_history_actions;
export function get(db: Database.Database, id: string) {
  const row = getStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "native_history_actions");
}

const insertUnknownStatement = statement(
  "INSERT INTO native_history_actions VALUES(?,?,'unknown',NULL,?)",
);
export function insertUnknown(
  db: Database.Database,
  id: string,
  catalog: string,
  created: number,
) {
  return insertUnknownStatement(db).run(id, catalog, created);
}

const completeStatement = statement(
  "UPDATE native_history_actions SET state='completed',conversation_id=? WHERE id=?",
);
export function complete(
  db: Database.Database,
  conversation: string,
  id: string,
) {
  return completeStatement(db).run(conversation, id);
}
