import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
import { answerPredicate, nonemptyAnswer } from "../feed-answers.js";
import { CAROUSEL_PAGE_CARDS } from "../../shared/done-stack.js";
import { STARTED_RUN_DISPLAY_STATES } from "../../shared/run-state.js";
// Order/eligibility is maintained transactionally by migrations 065/073. Materialize
// only the page before joining content and current run/delivery state. CROSS JOIN
// keeps the page as the outer loop: for the carousel's UNION ALL page the planner
// otherwise scans every message behind the view (~160 ms on a 24 GB workspace).
const projectPageSql = `SELECT m.id,m.owner_id,m.conversation_id,m.run_id,m.role,m.content,
  m.metadata,m.created_at,m.revision,m.run_state,m.run_error,m.run_checkout,m.run_verification,
  p.position,p.phase,p.ordinal
FROM page p
CROSS JOIN message_projection m ON m.id=p.message_id AND m.owner_id=p.owner_id
ORDER BY p.position DESC,p.phase DESC,p.ordinal DESC`;

export const transcriptPageSql = `WITH page AS MATERIALIZED (
  SELECT * FROM conversation_transcript
  WHERE owner_id=? AND conversation_id=? AND (position,phase,ordinal)<(?,?,?)
  ORDER BY position DESC,phase DESC,ordinal DESC LIMIT ?
) ${projectPageSql}`;

// Published steering replies are stored as progress but are also user-facing cards.
const carouselAnswer = `(${answerPredicate("m")} OR (
  m.role='assistant' AND EXISTS (
    SELECT 1 FROM steering_replies reply
    JOIN results res ON res.owner_id=reply.owner_id AND res.id='reply:'||reply.message_id
      AND res.sealed=1 AND res.kind='steering_reply'
    WHERE reply.owner_id=m.owner_id AND reply.message_id=m.id
      AND ${nonemptyAnswer("json_extract(res.outcome,'$.body')")}
  )
))`;

// Read one extra assistant position for the cursor. Join full message bodies
// only for the selected cards and the immediately preceding applicable prompts.
export const carouselPageSql = `WITH candidates AS MATERIALIZED (
  SELECT t.owner_id,t.conversation_id,t.message_id,t.position,t.phase,t.ordinal
  FROM conversation_transcript t
  JOIN messages m ON m.id=t.message_id AND m.owner_id=t.owner_id
  WHERE t.owner_id=? AND t.conversation_id=? AND (t.position,t.phase,t.ordinal)<(?,?,?)
    AND ${carouselAnswer}
  ORDER BY t.position DESC,t.phase DESC,t.ordinal DESC LIMIT ${CAROUSEL_PAGE_CARDS + 1}
), cards AS (
  SELECT * FROM candidates ORDER BY position DESC,phase DESC,ordinal DESC LIMIT ${CAROUSEL_PAGE_CARDS}
), page AS MATERIALIZED (
  SELECT owner_id,message_id,position,phase,ordinal FROM cards
  UNION ALL
  SELECT p.owner_id,p.message_id,p.position,p.phase,p.ordinal
  FROM cards c JOIN conversation_transcript p ON p.ordinal=(
    SELECT t.ordinal FROM conversation_transcript t
    JOIN messages m ON m.id=t.message_id AND m.owner_id=t.owner_id
    WHERE t.owner_id=c.owner_id AND t.conversation_id=c.conversation_id
      AND (t.position,t.phase,t.ordinal)<(c.position,c.phase,c.ordinal)
      AND (m.role='user' OR (${carouselAnswer}))
    ORDER BY t.position DESC,t.phase DESC,t.ordinal DESC LIMIT 1
  )
  JOIN messages prompt ON prompt.id=p.message_id AND prompt.owner_id=p.owner_id AND prompt.role='user'
) SELECT projected.*, (SELECT count(*)>${CAROUSEL_PAGE_CARDS} FROM candidates) AS has_more
FROM (${projectPageSql}) projected
ORDER BY projected.position DESC,projected.phase DESC,projected.ordinal DESC`;
const carouselPageStatement = statement(carouselPageSql);

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
    limit: number,
  ]
) {
  return pageStatement(db)
    .all(...bindings)
    .map((row) => parseRecord(pageRow, row, "conversation_transcript"));
}

const carouselPageRow = pageRow.extend({ has_more: z.number() });
export function carouselPage(
  db: Database.Database,
  ...bindings: [
    owner: string,
    conversation: string,
    position: number,
    phase: number,
    ordinal: number,
  ]
) {
  return carouselPageStatement(db)
    .all(...bindings)
    .map((row) => parseRecord(carouselPageRow, row, "conversation_transcript"));
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

const latestProgressMessagesStatement = statement(
  `SELECT r.id run_id,t.message_id id,t.position,t.phase,t.ordinal
   FROM runs r JOIN conversation_transcript t ON t.ordinal=(
     SELECT p.ordinal FROM conversation_transcript p
     JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
     WHERE p.owner_id=r.owner_id AND p.run_id=r.id AND p.conversation_id=r.conversation_id
       AND p.position IS NOT NULL AND m.role='assistant' AND json_extract(m.metadata,'$.progress')=1
     ORDER BY p.position DESC,p.phase DESC,p.ordinal DESC LIMIT 1
   )
   WHERE r.owner_id=? AND r.conversation_id=?
     AND r.state IN (${STARTED_RUN_DISPLAY_STATES.map(() => "?").join(",")})`,
);
const latestProgressMessageRow = positionRow.extend({
  id: z.string(),
  run_id: z.string(),
});
export function latestProgressMessages(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  return latestProgressMessagesStatement(db)
    .all(owner, conversation, ...STARTED_RUN_DISPLAY_STATES)
    .map((row) =>
      parseRecord(latestProgressMessageRow, row, "conversation_transcript"),
    );
}

const messageSelection = `FROM conversation_transcript p JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
    WHERE p.owner_id=? AND p.run_id=? AND length(trim(m.content))>0
    ORDER BY p.position,p.phase,p.ordinal`;
const messageSql = `SELECT m.id,m.role,m.content,m.metadata,m.created_at
    ${messageSelection} LIMIT ?`;
const exportRowsStatement = statement(messageSql);
const exportSizeStatement = statement(
  `SELECT COALESCE(SUM(COALESCE(length(CAST(id AS BLOB)),0)+COALESCE(length(CAST(role AS BLOB)),0)+COALESCE(length(CAST(content AS BLOB)),0)+COALESCE(length(CAST(metadata AS BLOB)),0)),0) size FROM (${messageSql})`,
);
const exportHasMoreStatement = statement(
  `SELECT 1 ${messageSelection} LIMIT 1 OFFSET ?`,
);
const exportRow = QueryRecords.messages.pick({
  id: true,
  role: true,
  content: true,
  metadata: true,
  created_at: true,
});
export function exportRows(
  db: Database.Database,
  owner: string,
  run: string,
  limit: number,
) {
  return exportRowsStatement(db)
    .all(owner, run, limit)
    .map((row) => parseRecord(exportRow, row, "conversation-transcript"));
}
export function exportSize(
  db: Database.Database,
  owner: string,
  run: string,
  limit: number,
) {
  return parseRecord(
    z.object({ size: z.number() }),
    exportSizeStatement(db).get(owner, run, limit),
    "conversation-transcript",
  ).size;
}
export function exportHasMore(
  db: Database.Database,
  owner: string,
  run: string,
  limit: number,
) {
  const row = exportHasMoreStatement(db).get(owner, run, limit);
  return (
    row !== undefined &&
    !!parseRecord(z.object({ "1": z.number() }), row, "conversation-transcript")
  );
}
