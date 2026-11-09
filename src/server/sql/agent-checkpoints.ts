import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsStatement = statement(
  "SELECT 1 FROM agent_checkpoints WHERE run_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, run: string) {
  const row = existsStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "agent_checkpoints");
}

const getStatement = statement(
  "SELECT * FROM agent_checkpoints WHERE run_id=?",
);
const getRow = QueryRecords.agent_checkpoints;
export function get(db: Database.Database, run: string) {
  const row = getStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "agent_checkpoints");
}

const insertStatement = statement(
  "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history) VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  run: string,
  message: string,
  artifact: string,
  history: string,
) {
  return insertStatement(db).run(run, message, artifact, history);
}

const historyStatement = statement(
  "UPDATE agent_checkpoints SET history=? WHERE run_id=?",
);
export function history(db: Database.Database, history: string, run: string) {
  return historyStatement(db).run(history, run);
}

const outputStatement = statement(
  "UPDATE agent_checkpoints SET output=? WHERE run_id=?",
);
export function output(db: Database.Database, output: string, run: string) {
  return outputStatement(db).run(output, run);
}

const pendingStatement = statement(
  "UPDATE agent_checkpoints SET history=?,pending=? WHERE run_id=?",
);
export function pending(
  db: Database.Database,
  history: string,
  pending: string,
  run: string,
) {
  return pendingStatement(db).run(history, pending, run);
}

const modelStageStatement = statement(
  "UPDATE agent_checkpoints SET stage='model',pending='[]' WHERE run_id=?",
);
export function modelStage(db: Database.Database, run: string) {
  return modelStageStatement(db).run(run);
}

const roundStatement = statement(
  "UPDATE agent_checkpoints SET round=? WHERE run_id=?",
);
export function round(db: Database.Database, round: number, run: string) {
  return roundStatement(db).run(round, run);
}

const roundHistoryStatement = statement(
  "UPDATE agent_checkpoints SET round=?,history=? WHERE run_id=?",
);
export function roundHistory(
  db: Database.Database,
  round: number,
  history: string,
  run: string,
) {
  return roundHistoryStatement(db).run(round, history, run);
}

const doneStatement = statement(
  "UPDATE agent_checkpoints SET round=?,history=?,stage='done' WHERE run_id=?",
);
export function done(
  db: Database.Database,
  round: number,
  history: string,
  run: string,
) {
  return doneStatement(db).run(round, history, run);
}

const toolsStageStatement = statement(
  "UPDATE agent_checkpoints SET round=?,history=?,pending=?,stage='tools' WHERE run_id=?",
);
export function toolsStage(
  db: Database.Database,
  round: number,
  history: string,
  pending: string,
  run: string,
) {
  return toolsStageStatement(db).run(round, history, pending, run);
}

const messageStatement = statement(
  "SELECT message_id FROM agent_checkpoints WHERE run_id=?",
);
const messageRow = QueryRecords.agent_checkpoints.pick({ message_id: true });
export function message(db: Database.Database, run: string) {
  const row = messageStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(messageRow, row, "agent_checkpoints");
}

const resultStatement = statement(
  "SELECT a.*,r.state run_state,r.error run_error,\n        json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata\n        FROM agent_checkpoints cp JOIN artifacts a ON a.id=cp.artifact_id AND a.owner_id=?\n        JOIN runs r ON r.id=cp.run_id WHERE cp.run_id=?",
);
const resultRow = QueryRecords.artifacts.extend({
  run_state: z.string(),
  run_error: z.string().nullable(),
});
export function result(db: Database.Database, owner: string, run: string) {
  const row = resultStatement(db).get(owner, run);
  return row === undefined
    ? undefined
    : parseRecord(resultRow, row, "agent_checkpoints");
}

const insertNativeStatement = statement(
  "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history) VALUES(?,?,?,'[]')",
);
export function insertNative(
  db: Database.Database,
  run: string,
  message: string,
  artifact: string,
) {
  return insertNativeStatement(db).run(run, message, artifact);
}

const nativeOutputStatement = statement(
  "UPDATE agent_checkpoints SET output=?,stage=? WHERE run_id=?",
);
export function nativeOutput(
  db: Database.Database,
  output: string,
  stage: string,
  run: string,
) {
  return nativeOutputStatement(db).run(output, stage, run);
}

const workerStageStatement = statement(
  "SELECT stage,round FROM agent_checkpoints WHERE run_id=?",
);
const workerStageRow = QueryRecords.agent_checkpoints.pick({
  stage: true,
  round: true,
});
export function workerStage(db: Database.Database, run: string) {
  const row = workerStageStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(workerStageRow, row, "agent_checkpoints");
}

const feedContentStatement = statement(
  "SELECT a.content FROM agent_checkpoints cp JOIN artifacts a ON a.id=cp.artifact_id AND a.owner_id=? JOIN runs r ON r.id=cp.run_id WHERE cp.run_id=?",
);
const feedContentRow = QueryRecords.artifacts.pick({ content: true });
export function feedContent(db: Database.Database, owner: string, run: string) {
  const row = feedContentStatement(db).get(owner, run);
  return row === undefined
    ? undefined
    : parseRecord(feedContentRow, row, "agent_checkpoints");
}

const previewCompleteStatement = statement(
  "INSERT OR REPLACE INTO agent_checkpoints(run_id,message_id,artifact_id,history,output,stage) VALUES(?,?,?,?,?,'done')",
);
export function previewComplete(
  db: Database.Database,
  run: string,
  message: string,
  artifact: string,
  history: string,
  output: string,
) {
  return previewCompleteStatement(db).run(
    run,
    message,
    artifact,
    history,
    output,
  );
}
