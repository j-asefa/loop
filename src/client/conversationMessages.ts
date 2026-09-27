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
export function mergeConversationMessages(
  previous: ConversationMessage[],
  incoming: ConversationMessage[],
) {
  const messages = [
    ...new Map(
      [...previous, ...incoming].map((message) => [message.id, message]),
    ).values(),
  ];
  const completed = new Set(
    messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !parse<any>(message.metadata, {}).progress,
      )
      .map(
        (message) =>
          "trace:" + parse<any>(message.metadata, {}).completedTraceId,
      ),
  );
  return messages
    .filter((message) => !completed.has(message.id))
    .sort(
      (a, b) =>
        a.cursor[0] - b.cursor[0] ||
        a.cursor[1] - b.cursor[1] ||
        a.cursor[2] - b.cursor[2],
    );
}
