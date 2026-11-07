import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const receiptStatement = statement(
  "SELECT request,conversation_id,run_id FROM continuation_requests WHERE owner_id=? AND idempotency_key=?",
);
const receiptRow = QueryRecords.continuation_requests.pick({
  request: true,
  conversation_id: true,
  run_id: true,
});
export function receipt(db: Database.Database, owner: string, key: string) {
  const row = receiptStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(receiptRow, row, "continuation_requests");
}

const insertStatement = statement(
  "INSERT INTO continuation_requests(owner_id,idempotency_key,request,conversation_id,run_id,created_at) VALUES(?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  key: string,
  request: string,
  conversation: string,
  run: string,
  created: number,
) {
  return insertStatement(db).run(
    owner,
    key,
    request,
    conversation,
    run,
    created,
  );
}
