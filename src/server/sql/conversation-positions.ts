import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const positionStatement = statement(
  "SELECT position_message_id FROM conversation_positions WHERE owner_id=? AND conversation_id=?",
);
const positionRow = QueryRecords.conversation_positions.pick({
  position_message_id: true,
});
export function position(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  const row = positionStatement(db).get(owner, conversation);
  return row === undefined
    ? undefined
    : parseRecord(positionRow, row, "conversation_positions");
}

const saveStatement = statement(
  "INSERT INTO conversation_positions(owner_id,conversation_id,position_message_id,updated_at) VALUES(?,?,?,?)\n        ON CONFLICT(owner_id,conversation_id) DO UPDATE SET position_message_id=excluded.position_message_id,updated_at=excluded.updated_at",
);
export function save(
  db: Database.Database,
  owner: string,
  conversation: string,
  message: string | null,
  updated: number,
) {
  return saveStatement(db).run(owner, conversation, message, updated);
}
