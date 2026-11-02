import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const countStatement = statement(
  "SELECT count(*) n FROM delegations WHERE parent_run_id=?",
);
const countRow = z.object({ n: z.number() });
export function count(db: Database.Database, parent: string) {
  const row = countStatement(db).get(parent);
  return row === undefined
    ? undefined
    : parseRecord(countRow, row, "delegations");
}

const callChildrenStatement = statement(
  "SELECT d.*,r.state,r.result,r.error,r.agent_id,r.id FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=? AND substr(d.call_id,1,?)=?",
);
const callChildrenRow = QueryRecords.delegations.extend({
  state: QueryRecords.runs.shape.state,
  result: QueryRecords.runs.shape.result,
  error: QueryRecords.runs.shape.error,
  agent_id: QueryRecords.runs.shape.agent_id,
  id: QueryRecords.runs.shape.id,
});
export function callChildren(
  db: Database.Database,
  parent: string,
  prefixLength: number,
  prefix: string,
) {
  return callChildrenStatement(db)
    .all(parent, prefixLength, prefix)
    .map((row) => parseRecord(callChildrenRow, row, "delegations"));
}

const insertStatement = statement(
  "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  parent: string,
  call: string,
  child: string,
  args: string,
  background: number,
) {
  return insertStatement(db).run(parent, call, child, args, background);
}

const childOfDelegateOrWorkflowStatement = statement(
  "SELECT 1 FROM delegations WHERE child_run_id=? UNION ALL SELECT 1 FROM workflow_steps WHERE child_run_id=?",
);
const childOfDelegateOrWorkflowRow = z.object({ "1": z.number() });
export function childOfDelegateOrWorkflow(
  db: Database.Database,
  delegate: string,
  workflow: string,
) {
  const row = childOfDelegateOrWorkflowStatement(db).get(delegate, workflow);
  return row === undefined
    ? undefined
    : parseRecord(childOfDelegateOrWorkflowRow, row, "delegations");
}
