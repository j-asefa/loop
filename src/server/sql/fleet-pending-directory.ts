import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const savedStatement = statement(
  "SELECT head,signed,receipt FROM fleet_pending_directory WHERE owner_id=? AND operation_id=?",
);
const savedRow = QueryRecords.fleet_pending_directory.pick({
  head: true,
  signed: true,
  receipt: true,
});
export function saved(db: Database.Database, owner: string, operation: string) {
  const row = savedStatement(db).get(owner, operation);
  return row === undefined
    ? undefined
    : parseRecord(savedRow, row, "fleet_pending_directory");
}

const saveStatement = statement(
  "INSERT INTO fleet_pending_directory(owner_id,operation_id,head,signed,receipt) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,operation_id) DO UPDATE SET head=excluded.head,signed=excluded.signed,receipt=excluded.receipt",
);
export function save(
  db: Database.Database,
  owner: string,
  operation: string,
  head: string,
  signed: string,
  receipt: string,
) {
  return saveStatement(db).run(owner, operation, head, signed, receipt);
}
