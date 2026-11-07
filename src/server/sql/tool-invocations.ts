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

const byCallStatement = statement(
  "SELECT * FROM tool_invocations WHERE run_id=? AND call_id=?",
);
const byCallRow = QueryRecords.tool_invocations;
export function byCall(db: Database.Database, run: string, call: string) {
  const row = byCallStatement(db).get(run, call);
  return row === undefined
    ? undefined
    : parseRecord(byCallRow, row, "tool_invocations");
}

const insertPendingStatement = statement(
  "INSERT INTO tool_invocations(id,owner_id,run_id,connection_id,agent_id,call_id,tool,args,state,approval_id,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
);
export function insertPending(
  db: Database.Database,
  id: string,
  owner: string,
  run: string,
  connection: string,
  agent: string | null,
  call: string,
  tool: string,
  args: string,
  approval: string,
  created: number,
) {
  return insertPendingStatement(db).run(
    id,
    owner,
    run,
    connection,
    agent,
    call,
    tool,
    args,
    approval,
    created,
  );
}

const byIdStatement = statement("SELECT * FROM tool_invocations WHERE id=?");
const byIdRow = QueryRecords.tool_invocations;
export function byId(db: Database.Database, id: string) {
  const row = byIdStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(byIdRow, row, "tool_invocations");
}

const startPendingStatement = statement(
  "UPDATE tool_invocations SET state='executing' WHERE id=? AND state='pending'",
);
export function startPending(db: Database.Database, id: string) {
  return startPendingStatement(db).run(id);
}

const completeStatement = statement(
  "UPDATE tool_invocations SET state=?,result=?,artifact_id=? WHERE id=?",
);
export function complete(
  db: Database.Database,
  state: string,
  result: string,
  artifact: string,
  id: string,
) {
  return completeStatement(db).run(state, result, artifact, id);
}

// A crash during a tool call leaves the invocation 'executing' forever. Once
// its run is no longer actively executing (recovered, ended), mark it
// 'unknown' so the stored state reflects the uncertain outcome (#355 S1).
const sweepExecutingStatement = statement(
  "UPDATE tool_invocations SET state='unknown',result=? WHERE state='executing' AND run_id IN (SELECT id FROM runs WHERE state NOT IN ('running','pausing'))",
);
export function sweepExecuting(db: Database.Database, result: string) {
  return sweepExecutingStatement(db).run(result);
}

const unknownExecutingStatement = statement(
  "UPDATE tool_invocations SET state='unknown',result=? WHERE id=? AND state IN ('executing','unknown')",
);
export function unknownExecuting(
  db: Database.Database,
  result: string,
  id: string,
) {
  return unknownExecutingStatement(db).run(result, id);
}
