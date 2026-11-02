import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownerExistsStatement = statement(
  "SELECT 1 FROM agents WHERE owner_id=? AND id=?",
);
const ownerExistsRow = z.object({ "1": z.number() });
export function ownerExists(
  db: Database.Database,
  owner: string,
  agent: string,
) {
  const row = ownerExistsStatement(db).get(owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(ownerExistsRow, row, "agents");
}

const existsOwnedStatement = statement(
  "SELECT 1 FROM agents WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(db: Database.Database, id: string, owner: string) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "agents");
}
