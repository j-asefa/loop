import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedSizeStatement = statement(
  "SELECT length(bytes) size FROM objects WHERE id=? AND owner_id=?",
);
const ownedSizeRow = z.object({ size: z.number() });
export function ownedSize(db: Database.Database, id: string, owner: string) {
  const row = ownedSizeStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedSizeRow, row, "objects");
}

const ownedStatement = statement(
  "SELECT * FROM objects WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.objects, row, "objects");
}
