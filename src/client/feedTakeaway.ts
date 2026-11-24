// A Done card shows a finished answer's takeaway: its opening paragraph,
// when the answer leads with a short prose paragraph and continues with
// more prose. Anything else keeps the ordinary preview: answers that open
// with or move straight into a heading, list, quote, table, code, math,
// HTML or a display spec; lead-ins ending in ":" or "…"; and replies,
// questions and unfinished work, which the user needs to see in full.

const MAX_TAKEAWAY_CHARS = 220;
const NOT_PROSE =
  /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|<|!\[|-{3,}\s*$|\$\$|:::|\[[^\]]+\]:)/;
const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/;

function prose(block: string) {
  return block
    .split("\n")
    .every(
      (line) =>
        !/^( {4}|\t)/.test(line) &&
        !NOT_PROSE.test(line.trim()) &&
        !TABLE_RULE.test(line.trim()),
    );
}

/** The answer's opening paragraph, or null to show the ordinary preview. */
export function feedTakeaway(markdown: string): string | null {
  const blocks = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd()
    .split(/\n[ \t]*\n/);
  if (blocks.length < 2) return null;
  const lead = blocks[0].trim();
  const next = blocks[1].replace(/^\n+/, "");
  if (!lead || lead.length > MAX_TAKEAWAY_CHARS) return null;
  if (/(:|…|\.\.\.)$/.test(lead)) return null;
  if (!prose(blocks[0]) || !prose(next)) return null;
  return lead;
}

/**
 * The takeaway a feed card shows, if any: only a finished assistant answer
 * read as a card, never a reply, a display-spec card, a live preview or a
 * thread whose run is still queued or working.
 */
export function cardTakeaway(
  item: {
    card?: unknown;
    live_preview?: string | null;
    reply?: unknown;
    run?: { state: string } | null;
    last_message?: {
      role: string;
      content?: string | null;
      preview?: string | null;
    } | null;
  },
  readAsCard: boolean,
): string | null {
  if (
    !readAsCard ||
    item.card ||
    item.live_preview ||
    item.reply ||
    (item.run && item.run.state !== "completed") ||
    item.last_message?.role !== "assistant"
  )
    return null;
  return feedTakeaway(
    item.last_message.content ?? item.last_message.preview ?? "",
  );
}
