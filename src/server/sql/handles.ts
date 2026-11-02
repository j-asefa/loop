import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsStatement = statement("SELECT 1 FROM handles WHERE name=?");
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, name: string) {
  const row = existsStatement(db).get(name);
  return row === undefined ? undefined : parseRecord(existsRow, row, "handles");
}

const insertStatement = statement("INSERT INTO handles VALUES(?,?,?)");
export function insert(
  db: Database.Database,
  name: string,
  agent: string,
  created: number,
) {
  return insertStatement(db).run(name, agent, created);
}

const agentStatement = statement("SELECT agent_id FROM handles WHERE name=?");
const agentRow = QueryRecords.handles.pick({ agent_id: true });
export function agent(db: Database.Database, name: string) {
  const row = agentStatement(db).get(name);
  return row === undefined ? undefined : parseRecord(agentRow, row, "handles");
}

const reserveStatement = statement(
  "INSERT OR IGNORE INTO handles VALUES(?,?,?)",
);
export function reserve(
  db: Database.Database,
  name: string,
  agent: string,
  created: number,
) {
  return reserveStatement(db).run(name, agent, created);
}
