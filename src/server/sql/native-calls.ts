import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM native_calls WHERE run_id=? AND call_id=?",
);
const getRow = QueryRecords.native_calls;
export function get(db: Database.Database, run: string, call: string) {
  const row = getStatement(db).get(run, call);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "native_calls");
}

const insertStatement = statement(
  "INSERT OR IGNORE INTO native_calls(run_id,call_id,tool,arguments) VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  run: string,
  call: string,
  tool: string,
  args: string,
) {
  return insertStatement(db).run(run, call, tool, args);
}

const approvalStatement = statement(
  "UPDATE native_calls SET approval_id=? WHERE run_id=? AND call_id=?",
);
export function approval(
  db: Database.Database,
  approval: string,
  run: string,
  call: string,
) {
  return approvalStatement(db).run(approval, run, call);
}

const resultStatement = statement(
  "UPDATE native_calls SET result=?,artifact_id=? WHERE run_id=? AND call_id=?",
);
export function result(
  db: Database.Database,
  result: string,
  artifact: string | null,
  run: string,
  call: string,
) {
  return resultStatement(db).run(result, artifact, run, call);
}
