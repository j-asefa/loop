import { z } from "zod";
import { db } from "./db.js";
import { Problem } from "./domain.js";
import type { Message } from "../shared/types.js";

type Position = [number, number, number];
type Entry = Message & { position: number; phase: number; ordinal: number };
const position = (item: Entry): Position => [
  item.position,
  item.phase,
  item.ordinal,
];
const encode = (value: Position) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// Transcripts show human, agent and system messages. Native tool rows stay
// out except failure and uncertain-delivery notices, which have no trace when
// they arrive outside a turn; keep transcriptMessage in the client in step.
// Group a run's public updates between its prompt and saved answer, including
// when several prompts were queued before an earlier run produced its answer.
export function conversationMessages(
  owner: string,
  conversation: string,
  before?: string,
  anchor?: string,
) {
  let cursor: Position = [
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  ];
  if (before) {
    try {
      cursor = z
        .tuple([
          z.number().int().nonnegative(),
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z.number().int().nonnegative(),
        ])
        .parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")));
    } catch {
      throw new Problem(400, "Invalid conversation cursor");
    }
  }
  const entries = `WITH entries AS (
    SELECT m.id,m.owner_id,m.conversation_id,m.run_id,m.role,m.content,
      json_set(m.metadata,'$.completedTraceId',(SELECT max(t.id) FROM run_traces t
        WHERE t.owner_id=m.owner_id AND t.run_id=m.run_id AND t.kind='message'
        AND json_extract(t.metadata,'$.final')=1),
        '$.delivery',(SELECT state FROM run_steering s WHERE s.message_id=m.id),
        '$.deliveryError',(SELECT error FROM run_steering s WHERE s.message_id=m.id)) metadata,
      m.created_at,r.state run_state,r.error run_error,
      COALESCE((SELECT min(prompt.rowid) FROM messages prompt WHERE prompt.owner_id=m.owner_id
        AND prompt.run_id=m.run_id AND prompt.role='user'),m.rowid) position,
      CASE WHEN m.role='assistant' THEN 9007199254740991
        WHEN json_extract(m.metadata,'$.steeringId') IS NOT NULL THEN m.created_at ELSE 0 END phase,
      m.rowid*2 ordinal
    FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
    WHERE m.owner_id=? AND m.conversation_id=? AND (m.role IN ('user','assistant','system')
      OR (m.role='tool' AND json_extract(m.metadata,'$.native.type') IN ('error','loop-delivery-unknown','loop-interrupted')))
    UNION ALL
    SELECT 'trace:'||t.id,t.owner_id,r.conversation_id,t.run_id,'assistant',t.content,
      json_set(t.metadata,'$.progress',json('true')),t.created_at,r.state,r.error,
      (SELECT min(prompt.rowid) FROM messages prompt WHERE prompt.owner_id=t.owner_id
        AND prompt.run_id=t.run_id),t.created_at,t.id*2+1
    FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
    WHERE t.owner_id=? AND r.conversation_id=? AND t.kind='message'
      AND json_extract(t.metadata,'$.final') IS NOT 1 AND length(trim(t.content))>0
  )`;
  const bindings = [owner, conversation, owner, conversation];
  if (anchor) {
    const entry = db
      .prepare(entries + " SELECT * FROM entries WHERE id=?")
      .get(...bindings, anchor) as Entry | undefined;
    // A row the transcript hides (raw native activity) can still be a saved
    // position, search hit or notification target: open the page around
    // where it was rather than failing the whole conversation.
    const hidden = entry
      ? undefined
      : (db
          .prepare(
            `SELECT COALESCE((SELECT min(prompt.rowid) FROM messages prompt WHERE prompt.owner_id=m.owner_id
              AND prompt.run_id=m.run_id AND prompt.role='user'),m.rowid) position,
              CASE WHEN json_extract(m.metadata,'$.steeringId') IS NOT NULL THEN m.created_at ELSE 0 END phase,
              m.rowid*2 ordinal
            FROM messages m WHERE m.owner_id=? AND m.conversation_id=? AND m.id=?`,
          )
          .get(owner, conversation, anchor) as Entry | undefined);
    if (!entry && !hidden) throw new Problem(404, "Message not found");
    cursor = position((entry || hidden)!);
    cursor[2]++;
  }
  const items = db
    .prepare(
      entries +
        " SELECT * FROM entries WHERE (position,phase,ordinal)<(?,?,?) ORDER BY position DESC,phase DESC,ordinal DESC LIMIT 51",
    )
    .all(...bindings, ...cursor) as Entry[];
  const hasMore = items.length > 50;
  if (hasMore) items.pop();
  return {
    next: hasMore ? encode(position(items.at(-1)!)) : null,
    messages: items
      .reverse()
      .map(({ position: p, phase, ordinal, ...message }) => ({
        ...message,
        cursor: [p, phase, ordinal] as Position,
      })),
  };
}
