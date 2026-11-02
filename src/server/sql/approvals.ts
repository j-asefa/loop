import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsOwnedStatement = statement(
  "SELECT 1 FROM approvals WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(db: Database.Database, id: string, owner: string) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "approvals");
}

const ownedStatement = statement(
  "SELECT * FROM approvals WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.approvals, row, "approvals");
}

const completeStatement = statement(
  "UPDATE approvals SET state='completed',result=? WHERE id=?",
);
export function complete(
  db: Database.Database,
  result: string,
  approval: string,
) {
  return completeStatement(db).run(result, approval);
}
