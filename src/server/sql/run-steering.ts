import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const replyTargetStatement = statement(
  "SELECT s.id FROM run_steering s\n      JOIN messages m ON m.id=s.message_id AND m.owner_id=s.owner_id\n      WHERE s.owner_id=? AND s.run_id=? AND s.message_id=? AND m.conversation_id=?\n        AND m.role='user' AND json_extract(m.metadata,'$.automation') IS NULL\n        AND s.state IN ('sending','delivered','failed')",
);
const replyTargetRow = QueryRecords.run_steering.pick({ id: true });
export function replyTarget(
  db: Database.Database,
  owner: string,
  run: string,
  message: string,
  conversation: string | null,
) {
  const row = replyTargetStatement(db).get(owner, run, message, conversation);
  return row === undefined
    ? undefined
    : parseRecord(replyTargetRow, row, "run_steering");
}
