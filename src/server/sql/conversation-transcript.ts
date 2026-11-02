import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
// Order/eligibility is maintained transactionally by migrations 065/073. Materialize
// only the page before joining content and current run/delivery state.
export const transcriptPageSql = `WITH page AS MATERIALIZED (
  SELECT * FROM conversation_transcript
  WHERE owner_id=? AND conversation_id=? AND (position,phase,ordinal)<(?,?,?)
  ORDER BY position DESC,phase DESC,ordinal DESC LIMIT 51
) SELECT m.id,m.owner_id,m.conversation_id,m.run_id,m.role,m.content,
  m.metadata,m.created_at,m.revision,m.run_state,m.run_error,m.run_checkout,m.run_verification,
  p.position,p.phase,p.ordinal
FROM page p
JOIN message_projection m ON m.id=p.message_id AND m.owner_id=p.owner_id
ORDER BY p.position DESC,p.phase DESC,p.ordinal DESC`;

const positionRow = QueryRecords.conversation_transcript
  .pick({ position: true, phase: true, ordinal: true })
  .extend({ position: z.number() });
const pageRow = QueryRecords.messages
  .pick({
    id: true,
    owner_id: true,
    conversation_id: true,
    run_id: true,
    role: true,
    content: true,
    metadata: true,
    created_at: true,
    revision: true,
  })
  .extend({
    run_state: z.string().nullable(),
    run_error: z.string().nullable(),
    run_checkout: z.string().nullable(),
    run_verification: z.string().nullable(),
    ...positionRow.shape,
  });

const anchorStatement = statement(
  "SELECT position,phase,ordinal FROM conversation_transcript WHERE owner_id=? AND conversation_id=? AND message_id=?",
);
const anchorRow = positionRow;
export function anchor(
  db: Database.Database,
  ...bindings: [owner: string, conversation: string, message: string]
) {
  const row = anchorStatement(db).get(...bindings);
  return row === undefined
    ? undefined
    : parseRecord(anchorRow, row, "conversation_transcript");
}

const hiddenAnchorStatement = statement(
  "SELECT position,phase,ordinal FROM transcript_message_entries WHERE owner_id=? AND conversation_id=? AND message_id=?",
);
const hiddenAnchorRow = positionRow;
export function hiddenAnchor(
  db: Database.Database,
  ...bindings: [owner: string, conversation: string, message: string]
) {
  const row = hiddenAnchorStatement(db).get(...bindings);
  return row === undefined
    ? undefined
    : parseRecord(hiddenAnchorRow, row, "conversation_transcript");
}

const pageStatement = statement(transcriptPageSql);
export function page(
  db: Database.Database,
  ...bindings: [
    owner: string,
    conversation: string,
    position: number,
    phase: number,
    ordinal: number,
  ]
) {
  return pageStatement(db)
    .all(...bindings)
    .map((row) => parseRecord(pageRow, row, "conversation_transcript"));
}

const latestAgentMessageStatement =
  statement(`SELECT t.message_id id,t.position,t.phase,t.ordinal FROM conversation_transcript t
      JOIN messages m ON m.id=t.message_id AND m.owner_id=t.owner_id
      WHERE t.owner_id=? AND t.conversation_id=? AND t.position IS NOT NULL AND m.role='assistant'
      ORDER BY t.position DESC,t.phase DESC,t.ordinal DESC LIMIT 1`);
const latestAgentMessageRow = positionRow.extend({ id: z.string() });
export function latestAgentMessage(
  db: Database.Database,
  ...bindings: [owner: string, conversation: string]
) {
  const row = latestAgentMessageStatement(db).get(...bindings);
  return row === undefined
    ? undefined
    : parseRecord(latestAgentMessageRow, row, "conversation_transcript");
}
