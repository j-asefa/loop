import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const coherentStatement = statement(
  "SELECT coherent FROM native_sessions WHERE conversation_id=?",
);
const coherentRow = QueryRecords.native_sessions.pick({ coherent: true });
export function coherent(db: Database.Database, conversation: string) {
  const row = coherentStatement(db).get(conversation);
  return row === undefined
    ? undefined
    : parseRecord(coherentRow, row, "native_sessions");
}
