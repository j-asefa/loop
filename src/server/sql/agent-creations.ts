import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const byRequestStatement = statement(
  "SELECT * FROM agent_creations WHERE owner_id=? AND request_key=?",
);

export function byRequest(db: Database.Database, owner: string, key: string) {
  const row = byRequestStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.agent_creations, row, "agent_creations");
}

const insertStatement = statement(
  "INSERT INTO agent_creations VALUES(?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  key: string,
  hash: string,
  agent: string,
  run: string | null,
  created: number,
) {
  return insertStatement(db).run(owner, key, hash, agent, run, created);
}
