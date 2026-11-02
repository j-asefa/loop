import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const priorStatement = statement(
  "SELECT * FROM webhook_requests WHERE owner_id=? AND request_id=?",
);
const priorRow = QueryRecords.webhook_requests;
export function prior(db: Database.Database, owner: string, request: string) {
  const row = priorStatement(db).get(owner, request);
  return row === undefined
    ? undefined
    : parseRecord(priorRow, row, "webhook_requests");
}

const insertStatement = statement(
  "INSERT INTO webhook_requests VALUES(?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  request: string,
  subscription: string,
  action: string,
  digest: string,
  result: string | null,
) {
  return insertStatement(db).run(
    owner,
    request,
    subscription,
    action,
    digest,
    result,
  );
}
