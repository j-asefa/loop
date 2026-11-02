import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const conversationRunsStatement = statement(
  "SELECT m.run_id FROM memory_receipts m JOIN runs r ON r.id=m.run_id\n        WHERE r.owner_id=? AND r.conversation_id=?",
);
const conversationRunsRow = QueryRecords.memory_receipts.pick({ run_id: true });
export function conversationRuns(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  return conversationRunsStatement(db)
    .all(owner, conversation)
    .map((row) => parseRecord(conversationRunsRow, row, "memory_receipts"));
}
