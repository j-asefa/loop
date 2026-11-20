import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
import {
  conversationContextSql,
  runInConversationContextSql,
} from "./messages.js";

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

const replaceStatement = statement(
  "INSERT OR REPLACE INTO memory_receipts VALUES(?,?,?,?,?)",
);
export function replace(
  db: Database.Database,
  run: string,
  mode: string,
  sources: string,
  tokens: number,
  created: number,
) {
  return replaceStatement(db).run(run, mode, sources, tokens, created);
}

const recalledIntoSessionStatement = statement(
  `SELECT 1 AS found FROM memory_receipts m
    JOIN runs r ON r.id=m.run_id AND r.owner_id=?
    JOIN native_dispatch d ON d.run_id=m.run_id
    WHERE r.conversation_id=? AND m.run_id<>?
      AND EXISTS (SELECT 1 FROM json_each(m.sources)
        WHERE json_extract(value,'$.via') IS NOT 'tool')
    LIMIT 1`,
);
/** Whether another run of the conversation sent recall into its native session. */
export function recalledIntoSession(
  db: Database.Database,
  owner: string,
  conversation: string,
  run: string,
) {
  return (
    recalledIntoSessionStatement(db).get(owner, conversation, run) !== undefined
  );
}

const removeStatement = statement("DELETE FROM memory_receipts WHERE run_id=?");
/** Forgets the receipt of a turn whose recall was never sent. */
export function remove(db: Database.Database, run: string) {
  return removeStatement(db).run(run);
}

const getStatement = statement("SELECT * FROM memory_receipts WHERE run_id=?");

export function get(db: Database.Database, run: string) {
  const row = getStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.memory_receipts, row, "memory_receipts");
}

const conversationHasEvidenceStatement = statement(
  `${conversationContextSql}
   SELECT 1 FROM context c
   JOIN runs r ON r.conversation_id=c.id AND r.owner_id=@owner
   JOIN memory_receipts m ON m.run_id=r.id
   WHERE ${runInConversationContextSql}
     AND (c.at IS NULL OR m.created_at<=c.at)
     AND EXISTS (SELECT 1 FROM json_each(m.sources))
   LIMIT 1`,
);
/** Whether this owner’s conversation or copied history contains saved evidence. */
export function conversationHasEvidence(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  return (
    conversationHasEvidenceStatement(db).get({ owner, conversation }) !==
    undefined
  );
}
