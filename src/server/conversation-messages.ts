import * as transcriptQueries from "./sql/conversation-transcript.js";
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

export { transcriptPageSql } from "./sql/conversation-transcript.js";

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
    const entry = transcriptQueries.anchor(db, owner, conversation, anchor) as
      Entry | undefined;
    // Saved/search links to hidden native rows still open where that row was.
    const hidden = entry
      ? undefined
      : (transcriptQueries.hiddenAnchor(db, owner, conversation, anchor) as
          Entry | undefined);
    const target = entry || hidden;
    if (!target) throw new Problem(404, "Message not found");
    cursor = position(target);
    cursor[2]++;
  }
  const items = transcriptQueries.page(
    db,
    owner,
    conversation,
    ...cursor,
  ) as Entry[];
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
  const entry = transcriptQueries.latestAgentMessage(
    db,
    owner,
    conversation,
  ) as
    | { id: string; position: number; phase: number; ordinal: number }
    | undefined;
  return entry
    ? {
        id: entry.id,
        cursor: [entry.position, entry.phase, entry.ordinal] as Position,
      }
    : null;
}
