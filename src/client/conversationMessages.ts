import type { Message } from "../shared/types";
import { parse } from "./api";

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
    const meta = parse<any>(existing.metadata, {});
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
