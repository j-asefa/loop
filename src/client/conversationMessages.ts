import {
  comparePosition,
  type ProjectedMessage,
} from "../shared/transcript-projection";
import type { Message } from "../shared/types";
import { readMessageMetadata } from "../shared/message-metadata";

export type ConversationMessage = Message & {
  cursor: [number, number, number];
};
export function conversationRefreshCursor(
  previous: ConversationMessage[],
  incoming: ConversationMessage[],
  currentNext: string | null,
  incomingNext: string | null,
) {
  if (!incomingNext) return null;
  const old = new Map(previous.map((message) => [message.id, message]));
  const overlap = incoming.some((message) => {
    const existing = old.get(message.id);
    if (!existing) return false;
    // An answer placeholder stays at the end of a running turn, even when
    // enough new updates arrived before it to leave an unloaded page-sized gap.
    const meta = readMessageMetadata(existing.metadata, "fallback");
    return (
      existing.role !== "assistant" ||
      meta.progress ||
      (!meta.partial &&
        ![
          "queued",
          "running",
          "pausing",
          "paused",
          "awaiting_approval",
          "waiting_children",
        ].includes(existing.run_state || ""))
    );
  });
  return overlap ? currentNext : incomingNext;
}

type ProgressPosition = {
  id: string;
  run_id: string;
  cursor: ConversationMessage["cursor"];
};
export function conversationLatestProgress(
  messages: Iterable<
    Pick<ProjectedMessage, "id" | "run_id" | "cursor" | "role" | "metadata">
  > = [],
  reported: readonly ProgressPosition[] = [],
) {
  const byRun = new Map(reported.map((message) => [message.run_id, message]));
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.run_id &&
      readMessageMetadata(message.metadata, "fallback").progress
    ) {
      const latest = byRun.get(message.run_id);
      if (!latest || comparePosition(message.cursor, latest.cursor) > 0)
        byRun.set(message.run_id, {
          id: message.id,
          run_id: message.run_id,
          cursor: message.cursor,
        });
    }
  }
  return byRun;
}
