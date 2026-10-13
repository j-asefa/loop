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

// Order/eligibility is maintained transactionally by migrations 065/073. Materialize
// only the page before joining content and current run/delivery state.
export const transcriptPageSql = `WITH page AS MATERIALIZED (
  SELECT * FROM conversation_transcript
  WHERE owner_id=? AND conversation_id=? AND (position,phase,ordinal)<(?,?,?)
  ORDER BY position DESC,phase DESC,ordinal DESC LIMIT 51
) SELECT m.id,p.owner_id,p.conversation_id,p.run_id,m.role,m.content,
  json_set(m.metadata,'$.completedMessageId',(SELECT final.id FROM messages final
    WHERE final.owner_id=p.owner_id AND final.run_id=p.run_id
      AND final.update_key IS NOT NULL AND json_extract(final.metadata,'$.final')=1
    ORDER BY final.rowid DESC LIMIT 1),
    '$.delivery',s.state,'$.deliveryError',s.error) metadata,
  m.created_at,r.state run_state,r.error run_error,
  (SELECT k.summary FROM run_checkouts k WHERE k.run_id=p.run_id AND k.owner_id=p.owner_id) run_checkout,
  p.position,p.phase,p.ordinal
FROM page p
JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
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
    // Saved/search links to hidden native rows still open where that row was.
    const hidden = entry
      ? undefined
      : (db
          .prepare(
            "SELECT position,phase,ordinal FROM transcript_message_entries WHERE owner_id=? AND conversation_id=? AND message_id=?",
          )
          .get(owner, conversation, anchor) as Entry | undefined);
    const target = entry || hidden;
    if (!target) throw new Problem(404, "Message not found");
    cursor = position(target);
    cursor[2]++;
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
