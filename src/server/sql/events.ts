import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const connectionStatusStatement = statement(
  "INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)\n        VALUES(?,NULL,'connection',?,'connection.status',?,?)",
);
export function connectionStatus(
  db: Database.Database,
  owner: string,
  id: string,
  payload: string,
  created: number,
) {
  return connectionStatusStatement(db).run(owner, id, payload, created);
}
