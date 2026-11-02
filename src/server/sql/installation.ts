import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownerStatement = statement(
  "SELECT owner_id FROM installation WHERE id=1",
);
const ownerRow = QueryRecords.installation.pick({ owner_id: true });
export function owner(db: Database.Database) {
  const row = ownerStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(ownerRow, row, "installation");
}

const setOwnerStatement = statement(
  "INSERT INTO installation(id,owner_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id",
);
export function setOwner(db: Database.Database, owner: string) {
  return setOwnerStatement(db).run(owner);
}
