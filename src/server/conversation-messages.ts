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
) SELECT m.id,m.owner_id,m.conversation_id,m.run_id,m.role,m.content,
  m.metadata,m.created_at,m.revision,m.run_state,m.run_error,m.run_checkout,m.run_verification,
  p.position,p.phase,p.ordinal
FROM page p
JOIN message_projection m ON m.id=p.message_id AND m.owner_id=p.owner_id
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
    range: {
      from: hasMore ? position(items.at(-1)!) : ([0, 0, 0] as Position),
      before: cursor,
    },
    messages: items
      .reverse()
      .map(({ position: p, phase, ordinal, ...message }) => ({
        ...message,
        cursor: [p, phase, ordinal] as Position,
      })),
  };
}

/** The agent's latest message in the visible transcript, wherever the page
 * is anchored, so a reply to it can go unquoted. */
export function latestAgentMessage(owner: string, conversation: string) {
  const entry = db
    .prepare(
      `SELECT t.message_id id,t.position,t.phase,t.ordinal FROM conversation_transcript t
      JOIN messages m ON m.id=t.message_id AND m.owner_id=t.owner_id
      WHERE t.owner_id=? AND t.conversation_id=? AND t.position IS NOT NULL AND m.role='assistant'
      ORDER BY t.position DESC,t.phase DESC,t.ordinal DESC LIMIT 1`,
    )
    .get(owner, conversation) as
    | { id: string; position: number; phase: number; ordinal: number }
    | undefined;
  return entry
    ? {
        id: entry.id,
        cursor: [entry.position, entry.phase, entry.ordinal] as Position,
      }
    : null;
}
