export type MemoryTimeWindow = {
  from: number | null;
  to: number | null;
  matched?: { index: number; text: string }[];
};

const DAY = 86_400_000;
const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );
const MONTH = MONTHS.join("|");
const ISO = "\\d{4}-\\d{2}-\\d{2}";
const NAMED_MONTH = `(?:${MONTH})(?:[ \\t]+\\d{4})?`;
const phrase = new RegExp(
  `(?<![\\p{L}\\p{N}_.-])(?:(since|before)[ \\t]+(${ISO}|${NAMED_MONTH})|on[ \\t]+(${ISO})|in[ \\t]+(${NAMED_MONTH})|(today|yesterday)|((?:this|last)[ \\t]+(?:week|month))|(\\d+)[ \\t]+(days?|weeks?)[ \\t]+ago)(?![\\p{L}\\p{N}_]|[.-][\\p{L}\\p{N}_])`,
  "giu",
);
const quoted =
  /"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/gu;

function dateBoundary(text: string, today: number) {
  if (/^\d/.test(text)) {
    const date = Date.parse(text + "T00:00:00Z");
    return Number.isFinite(date) &&
      new Date(date).toISOString().slice(0, 10) === text
      ? { start: date, end: date + DAY }
      : null;
  }
  const [name, year] = text.toLowerCase().split(/\s+/);
  const month = MONTHS.findIndex((value) => value.toLowerCase() === name);
  const now = new Date(today);
  let selectedYear = year ? Number(year) : now.getUTCFullYear();
  if (month < 0 || selectedYear < 100) return null;
  if (!year && month > now.getUTCMonth()) selectedYear--;
  return {
    start: Date.UTC(selectedYear, month, 1),
    end: Date.UTC(selectedYear, month + 1, 1),
  };
}

/** Parse an explicit time reference from the query in UTC, with an exclusive upper bound. */
export function parseMemoryTime(
  query: string,
  reference = Date.now(),
): MemoryTimeWindow | undefined {
  const today = Math.floor(reference / DAY) * DAY;
  if (!Number.isFinite(today)) return undefined;
  const date = new Date(today);
  const monday = today - ((date.getUTCDay() + 6) % 7) * DAY;
  const searchable = query.replace(quoted, (text) =>
    "\u0000".repeat(text.length),
  );
  let open: MemoryTimeWindow | undefined;
  for (const match of searchable.matchAll(phrase)) {
    const [, relation, target, iso, named, day, period, count, unit] = match;
    const matched = [{ index: match.index, text: match[0] }];
    if (target || iso || named) {
      const boundary = dateBoundary(target ?? iso ?? named, today);
      if (!boundary) continue;
      const modifier = relation?.toLowerCase();
      if (modifier === "since" || modifier === "before") {
        const from = modifier === "since" ? boundary.start : null;
        const to = modifier === "before" ? boundary.start : null;
        if (!open) open = { from, to, matched };
        else if (
          (open.from === null && from !== null) ||
          (open.to === null && to !== null)
        )
          return {
            from: open.from ?? from,
            to: open.to ?? to,
            matched: [...(open.matched ?? []), ...matched],
          };
        continue;
      }
      if (!open) return { from: boundary.start, to: boundary.end, matched };
    }
    if (open) continue;
    if (day) {
      const from = today - (day.toLowerCase() === "yesterday" ? DAY : 0);
      return { from, to: from + DAY, matched };
    }
    if (period) {
      const last = period.toLowerCase().startsWith("last");
      if (period.toLowerCase().endsWith("week")) {
        const from = monday - (last ? 7 * DAY : 0);
        return { from, to: from + 7 * DAY, matched };
      }
      const month = date.getUTCMonth() - (last ? 1 : 0);
      return {
        from: Date.UTC(date.getUTCFullYear(), month, 1),
        to: Date.UTC(date.getUTCFullYear(), month + 1, 1),
        matched,
      };
    }
    const ago = Number(count);
    if (!Number.isSafeInteger(ago) || ago > 100_000) continue;
    const weeks = unit.toLowerCase().startsWith("week");
    const span = weeks ? 7 * DAY : DAY;
    const from = (weeks ? monday : today) - ago * span;
    return { from, to: from + span, matched };
  }
  return open;
}

export function withoutMemoryTime(query: string, window?: MemoryTimeWindow) {
  return (window?.matched ?? []).reduceRight(
    (text, match) =>
      text.slice(0, match.index) +
      " " +
      text.slice(match.index + match.text.length),
    query,
  );
}
