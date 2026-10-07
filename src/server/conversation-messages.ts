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

// Order/eligibility is maintained transactionally by migration 065. Materialize
// only the page before joining content and current run/delivery state.
export const transcriptPageSql = `WITH page AS MATERIALIZED (
  SELECT * FROM conversation_transcript
  WHERE owner_id=? AND conversation_id=? AND (position,phase,ordinal)<(?,?,?)
  ORDER BY position DESC,phase DESC,ordinal DESC LIMIT 51
) SELECT COALESCE(m.id,'trace:'||t.id) id,p.owner_id,p.conversation_id,p.run_id,
  COALESCE(m.role,'assistant') role,COALESCE(m.content,t.content) content,
  CASE WHEN p.message_id IS NOT NULL THEN
    json_set(m.metadata,'$.completedTraceId',(SELECT max(final.id) FROM run_traces final
      WHERE final.owner_id=p.owner_id AND final.run_id=p.run_id AND final.kind='message'
      AND json_extract(final.metadata,'$.final')=1),
      '$.delivery',s.state,'$.deliveryError',s.error)
    ELSE json_set(t.metadata,'$.progress',json('true')) END metadata,
  COALESCE(m.created_at,t.created_at) created_at,r.state run_state,r.error run_error,
  p.position,p.phase,p.ordinal
FROM page p
LEFT JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
LEFT JOIN run_traces t ON t.id=p.trace_id AND t.owner_id=p.owner_id
LEFT JOIN runs r ON r.id=p.run_id AND r.owner_id=p.owner_id
LEFT JOIN run_steering s ON s.message_id=p.message_id AND s.owner_id=p.owner_id
ORDER BY p.position DESC,p.phase DESC,p.ordinal DESC`;

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
  if (anchor) {
    const entry = db
      .prepare(
        "SELECT position,phase,ordinal FROM conversation_transcript WHERE owner_id=? AND conversation_id=? AND message_id=?",
      )
      .get(owner, conversation, anchor) as Entry | undefined;
    const traceId = /^trace:(\d+)$/.exec(anchor)?.[1];
    const trace =
      !entry && traceId
        ? (db
            .prepare(
              "SELECT position,phase,ordinal FROM conversation_transcript WHERE owner_id=? AND conversation_id=? AND trace_id=?",
            )
            .get(owner, conversation, traceId) as Entry | undefined)
        : undefined;
    // Saved/search links to hidden native rows still open where that row was.
    const hidden =
      entry || trace
        ? undefined
        : (db
            .prepare(
              "SELECT position,phase,ordinal FROM transcript_message_entries WHERE owner_id=? AND conversation_id=? AND message_id=?",
            )
            .get(owner, conversation, anchor) as Entry | undefined);
    const target = entry || trace || hidden;
    if (!target) throw new Problem(404, "Message not found");
    // Progress recorded before its run stored any message has no position yet.
    // Open the newest page rather than failing the conversation it belongs to.
    if (target.position !== null) {
      cursor = position(target);
      cursor[2]++;
    }
  }
  const items = db
    .prepare(transcriptPageSql)
    .all(owner, conversation, ...cursor) as Entry[];
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
