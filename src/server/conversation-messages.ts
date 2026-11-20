import { TRANSCRIPT_PAGE_ITEMS } from "./pagination.js";
import { encodeCursor as encode, decodeCursor } from "./cursors.js";
import * as transcriptQueries from "./sql/conversation-transcript.js";
import { z } from "zod";
import { db } from "./db.js";
import { Problem } from "./domain.js";
import { STARTED_RUN_DISPLAY_STATES } from "../shared/run-state.js";

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
  const items = transcriptQueries.page(
    db,
    owner,
    conversation,
    ...cursor,
    TRANSCRIPT_PAGE_ITEMS + 1,
  );
  const hasMore = items.length > TRANSCRIPT_PAGE_ITEMS;
  if (hasMore) items.pop();
  const latestProgress: { run_id: string; id: string; cursor: Position }[] = [];
  if (anchor) {
    const activeRuns = new Set<string>();
    for (const item of items) {
      if (
        item.run_id &&
        item.run_state &&
        STARTED_RUN_DISPLAY_STATES.includes(item.run_state)
      )
        activeRuns.add(item.run_id);
    }
    for (const run of activeRuns) {
      const latest = transcriptQueries.latestProgressMessage(
        db,
        owner,
        run,
        conversation,
      );
      if (latest)
        latestProgress.push({
          run_id: run,
          id: latest.id,
          cursor: position(latest),
        });
    }
  }
  return {
    latest_progress_messages: anchor ? latestProgress : undefined,
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
  const entry = transcriptQueries.latestAgentMessage(db, owner, conversation);
  return entry
    ? {
        id: entry.id,
        cursor: [entry.position, entry.phase, entry.ordinal] as Position,
      }
    : null;
}
