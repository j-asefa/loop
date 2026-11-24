// A Done card shows a finished answer's takeaway: its opening paragraph,
// when the answer leads with one and continues after it. Answers that open
// with a heading, list, quote, table, code or a display spec, or with a
// paragraph too long to scan, keep the ordinary preview.

const MAX_TAKEAWAY_CHARS = 400;
const NOT_PROSE = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|<|!\[|-{3,}\s*$)/;

/** The answer's opening paragraph, or null to show the ordinary preview. */
export function feedTakeaway(markdown: string): string | null {
  const text = markdown.replace(/\r\n?/g, "\n").trim();
  const end = text.search(/\n[ \t]*\n/);
  if (end === -1) return null;
  const lead = text.slice(0, end).trim();
  if (!lead || lead.length > MAX_TAKEAWAY_CHARS) return null;
  if (lead.split("\n").some((line) => NOT_PROSE.test(line.trim()))) return null;
  return lead;
}
