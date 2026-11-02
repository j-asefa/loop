import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const recordStatement = statement(
  "SELECT record FROM agent_activities WHERE owner_id=? AND scope=? AND activity_key=?",
);
const recordRow = QueryRecords.agent_activities.pick({ record: true });
export function record(
  db: Database.Database,
  owner: string,
  scope: string | null,
  key: string,
) {
  const row = recordStatement(db).get(owner, scope, key);
  return row === undefined
    ? undefined
    : parseRecord(recordRow, row, "agent_activities");
}
