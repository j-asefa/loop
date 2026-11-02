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

const insertStatement = statement("INSERT INTO objects VALUES(?,?,?,?,?,?)");
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  mime: string,
  bytes: Buffer,
  created: number,
) {
  return insertStatement(db).run(id, owner, name, mime, bytes, created);
}

const cardOwnedStatement = statement(
  "SELECT 1 FROM objects WHERE owner_id=? AND id=?",
);
const cardOwnedRow = z.object({ "1": z.number() });
export function cardOwned(db: Database.Database, owner: string, id: string) {
  const row = cardOwnedStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(cardOwnedRow, row, "objects");
}
