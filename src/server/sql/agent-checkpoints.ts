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
