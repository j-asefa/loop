import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const expireResultsStatement = statement(
  "UPDATE token_requests SET operation=NULL,request_hash=NULL,response_status=NULL,locator=NULL\n    WHERE owner_id=? AND token_id=? AND state='complete' AND completed_at<? AND operation IS NOT NULL",
);
export function expireResults(
  db: Database.Database,
  owner: string,
  token: string,
  before: number,
) {
  return expireResultsStatement(db).run(owner, token, before);
}

const receiptStatement = statement(
  "SELECT operation,request_hash,state,response_status,locator FROM token_requests WHERE owner_id=? AND token_id=? AND identity=?",
);
const receiptRow = QueryRecords.token_requests.pick({
  operation: true,
  request_hash: true,
  state: true,
  response_status: true,
  locator: true,
});
export function receipt(
  db: Database.Database,
  owner: string,
  token: string,
  identity: string,
) {
  const row = receiptStatement(db).get(owner, token, identity);
  return row === undefined
    ? undefined
    : parseRecord(receiptRow, row, "token_requests");
}

const reserveStatement = statement(
  "INSERT INTO token_requests(owner_id,token_id,identity,operation,request_hash,state,created_at)\n    VALUES(?,?,?,?,?,'pending',?)",
);
export function reserve(
  db: Database.Database,
  owner: string,
  token: string,
  identity: string,
  operation: string,
  hash: string,
  created: number,
) {
  return reserveStatement(db).run(
    owner,
    token,
    identity,
    operation,
    hash,
    created,
  );
}

const completeStatement = statement(
  "UPDATE token_requests SET state='complete',response_status=?,locator=?,completed_at=?\n    WHERE owner_id=? AND token_id=? AND identity=? AND state='pending'",
);
export function complete(
  db: Database.Database,
  status: number,
  locator: string,
  time: number,
  owner: string,
  token: string,
  identity: string,
) {
  return completeStatement(db).run(
    status,
    locator,
    time,
    owner,
    token,
    identity,
  );
}
