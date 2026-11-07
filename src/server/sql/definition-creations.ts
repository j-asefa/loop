import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const byRequestStatement = statement(
  "SELECT * FROM definition_creations WHERE owner_id=? AND request_key=?",
);
const byRequestRow = QueryRecords.definition_creations;
export function byRequest(db: Database.Database, owner: string, key: string) {
  const row = byRequestStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(byRequestRow, row, "definition_creations");
}

const insertStatement = statement(
  "INSERT INTO definition_creations VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  key: string,
  hash: string,
  agent: string | null,
  team: string | null,
) {
  return insertStatement(db).run(owner, key, hash, agent, team);
}
