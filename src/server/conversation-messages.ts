import { TRANSCRIPT_PAGE_ITEMS } from "./pagination.js";
import { encodeCursor as encode, decodeCursor } from "./cursors.js";
import * as transcriptQueries from "./sql/conversation-transcript.js";
import { z } from "zod";
import { db } from "./db.js";
import { Problem } from "./domain.js";

type Position = [number, number, number];
type TranscriptPosition = NonNullable<
  ReturnType<typeof transcriptQueries.anchor>
>;
const position = (item: TranscriptPosition): Position => [
  item.position,
  item.phase,
  item.ordinal,
];
export { transcriptPageSql } from "./sql/conversation-transcript.js";

export function conversationMessages(
  owner: string,
  conversation: string,
  before?: string,
  anchor?: string,
  view?: "carousel",
) {
  let cursor: Position = [
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  ];
  if (before) {
    cursor = decodeCursor(
      before,
      z.tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        z.number().int().nonnegative(),
      ]),
      "Invalid conversation cursor",
    );
  }

  if (anchor) {
    const entry = transcriptQueries.anchor(db, owner, conversation, anchor);
    // Saved/search links to hidden native rows still open where that row was.
    const hidden = entry
      ? undefined
      : transcriptQueries.hiddenAnchor(db, owner, conversation, anchor);
    const target = entry || hidden;
    if (!target) throw new Problem(404, "Message not found");
    cursor = position(target);
    cursor[2]++;
  }
  const carousel =
    view === "carousel"
      ? transcriptQueries.carouselPage(db, owner, conversation, ...cursor)
      : undefined;
  const items = carousel
    ? carousel.map(({ has_more: _, ...item }) => item)
    : transcriptQueries.page(
        db,
        owner,
        conversation,
        ...cursor,
        TRANSCRIPT_PAGE_ITEMS + 1,
      );
  if (
    carousel &&
    anchor &&
    !items.some((item) => item.id === anchor && item.role === "assistant")
  ) {
    throw new Problem(404, "Answer card not found");
  }
  const hasMore = carousel
    ? carousel[0]?.has_more === 1
    : items.length > TRANSCRIPT_PAGE_ITEMS;
  if (!carousel && hasMore) items.pop();
  const oldest = carousel
    ? items.findLast((item) => item.role === "assistant")
    : items.at(-1);
  const nextPosition = hasMore && oldest ? position(oldest) : null;
  return {
    latest_progress_messages: transcriptQueries
      .latestProgressMessages(db, owner, conversation)
      .map((entry) => ({
        run_id: entry.run_id,
        id: entry.id,
        cursor: position(entry),
      })),
    next: nextPosition ? encode(nextPosition) : null,
    range: {
      from: nextPosition ?? ([0, 0, 0] as Position),
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
  const entry = transcriptQueries.latestAgentMessage(db, owner, conversation);
  return entry
    ? {
        id: entry.id,
        cursor: [entry.position, entry.phase, entry.ordinal] as Position,
      }
    : null;
}
