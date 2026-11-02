import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const byRequestStatement = statement(
  "SELECT * FROM mcp_federation_calls WHERE peer_id=? AND run_key=? AND request_key=?",
);
const byRequestRow = QueryRecords.mcp_federation_calls;
export function byRequest(
  db: Database.Database,
  peer: string,
  run: string,
  request: string,
) {
  const row = byRequestStatement(db).get(peer, run, request);
  return row === undefined
    ? undefined
    : parseRecord(byRequestRow, row, "mcp_federation_calls");
}

const insertExecutingStatement = statement(
  "INSERT INTO mcp_federation_calls(id,owner_id,peer_id,run_key,request_key,tool_name,args,state,created_at,updated_at)\n       VALUES(?,?,?,?,?,?,?,'executing',?,?) ON CONFLICT(peer_id,run_key,request_key) DO NOTHING",
);
export function insertExecuting(
  db: Database.Database,
  id: string,
  owner: string,
  peer: string,
  run: string,
  request: string,
  tool: string,
  args: string,
  created: number,
  updated: number,
) {
  return insertExecutingStatement(db).run(
    id,
    owner,
    peer,
    run,
    request,
    tool,
    args,
    created,
    updated,
  );
}

const completeStatement = statement(
  "UPDATE mcp_federation_calls SET state='completed',result=?,updated_at=? WHERE id=?",
);
export function complete(
  db: Database.Database,
  result: string,
  time: number,
  id: string,
) {
  return completeStatement(db).run(result, time, id);
}

const unknownStatement = statement(
  "UPDATE mcp_federation_calls SET state='unknown',updated_at=? WHERE id=?",
);
export function unknown(db: Database.Database, time: number, id: string) {
  return unknownStatement(db).run(time, id);
}
