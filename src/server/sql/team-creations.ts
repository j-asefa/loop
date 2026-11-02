import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM team_creations WHERE owner_id=? AND request_key=?",
);
const getRow = QueryRecords.team_creations;
export function get(db: Database.Database, owner: string, key: string) {
  const row = getStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "team_creations");
}

const insertStatement = statement("INSERT INTO team_creations VALUES(?,?,?,?)");
export function insert(
  db: Database.Database,
  owner: string,
  key: string,
  hash: string,
  team: string,
) {
  return insertStatement(db).run(owner, key, hash, team);
}
