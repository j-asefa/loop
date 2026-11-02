import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const isUnknownStatement = statement(
  "SELECT 1 FROM tool_invocations WHERE run_id=? AND call_id=? AND state='unknown'",
);
const isUnknownRow = z.object({ "1": z.number() });
export function isUnknown(db: Database.Database, run: string, call: string) {
  const row = isUnknownStatement(db).get(run, call);
  return row === undefined
    ? undefined
    : parseRecord(isUnknownRow, row, "tool_invocations");
}
