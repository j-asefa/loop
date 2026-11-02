import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const withChildStatement = statement(
  "SELECT s.*,r.conversation_id,r.state child_state FROM workflow_steps s LEFT JOIN runs r ON r.id=s.child_run_id WHERE s.run_id=? ORDER BY position",
);
const withChildRow = QueryRecords.workflow_steps.extend({
  conversation_id: z.string().nullable(),
  child_state: z.string().nullable(),
});
export function withChild(db: Database.Database, run: string) {
  return withChildStatement(db)
    .all(run)
    .map((row) => parseRecord(withChildRow, row, "workflow_steps"));
}

const activeTimeStatement = statement(
  "SELECT COALESCE(sum(r.active_ms + CASE WHEN r.active_since IS NOT NULL THEN max(0,?-r.active_since) ELSE 0 END),0) ms FROM workflow_steps s JOIN runs r ON r.id=s.child_run_id WHERE s.run_id=?",
);
const activeTimeRow = z.object({ ms: z.number() });
export function activeTime(db: Database.Database, time: number, run: string) {
  const row = activeTimeStatement(db).get(time, run);
  return row === undefined
    ? undefined
    : parseRecord(activeTimeRow, row, "workflow_steps");
}

const stepStatement = statement(
  "SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?",
);
const stepRow = QueryRecords.workflow_steps;
export function step(db: Database.Database, run: string, step: string) {
  const row = stepStatement(db).get(run, step);
  return row === undefined
    ? undefined
    : parseRecord(stepRow, row, "workflow_steps");
}

const insertPendingStatement = statement(
  "INSERT INTO workflow_steps(run_id,step_id,position,state) VALUES(?,?,?,'pending')",
);
export function insertPending(
  db: Database.Database,
  run: string,
  step: string,
  position: number,
) {
  return insertPendingStatement(db).run(run, step, position);
}

const completeStatement = statement(
  "UPDATE workflow_steps SET state='completed',output=? WHERE run_id=? AND step_id=?",
);
export function complete(
  db: Database.Database,
  output: string,
  run: string,
  step: string,
) {
  return completeStatement(db).run(output, run, step);
}

const startChildStatement = statement(
  "UPDATE workflow_steps SET state='running',child_run_id=? WHERE run_id=? AND step_id=?",
);
export function startChild(
  db: Database.Database,
  child: string,
  run: string,
  step: string,
) {
  return startChildStatement(db).run(child, run, step);
}

const approvalStatement = statement(
  "UPDATE workflow_steps SET approval_id=? WHERE run_id=? AND step_id=?",
);
export function approval(
  db: Database.Database,
  approval: string,
  run: string,
  step: string,
) {
  return approvalStatement(db).run(approval, run, step);
}

const completeArtifactStatement = statement(
  "UPDATE workflow_steps SET state='completed',output=?,artifact_id=? WHERE run_id=? AND step_id=?",
);
export function completeArtifact(
  db: Database.Database,
  output: string,
  artifact: string,
  run: string,
  step: string,
) {
  return completeArtifactStatement(db).run(output, artifact, run, step);
}
