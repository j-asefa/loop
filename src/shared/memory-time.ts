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
const NAMED_MONTH = `(?:${MONTH})(?:\\s+\\d{4})?`;
const RELATIVE =
  "(?:today|yesterday|(?:this|last)\\s+(?:week|month)|\\d+\\s+(?:days?|weeks?)\\s+ago)";
const phrase = new RegExp(
  `(?<![\\p{L}\\p{N}_./+@-])(?:(since|before)\\s+(${ISO}|${NAMED_MONTH}|${RELATIVE})|on\\s+(${ISO})|in\\s+(${NAMED_MONTH})|(${RELATIVE}))(?![\\p{L}\\p{N}_/+@]|[.-][\\p{L}\\p{N}_])`,
  "giu",
);
const quoted =
  /"(?:\\.|[^"\\\n])*"|(?<![\p{L}\p{N}])'(?:\\.|[^'\\\n])*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/gu;

function dateBoundary(text: string, today: number) {
  if (/^\d{4}-/.test(text)) {
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

function relativeBoundary(text: string, today: number) {
  const date = new Date(today);
  const monday = today - ((date.getUTCDay() + 6) % 7) * DAY;
  const [first, second] = text.toLowerCase().split(/\s+/);
  if (first === "today" || first === "yesterday") {
    const start = today - (first === "yesterday" ? DAY : 0);
    return { start, end: start + DAY };
  }
  if (first === "this" || first === "last") {
    const offset = first === "last" ? 1 : 0;
    if (second === "week") {
      const start = monday - offset * 7 * DAY;
      return { start, end: start + 7 * DAY };
    }
    const month = date.getUTCMonth() - offset;
    return {
      start: Date.UTC(date.getUTCFullYear(), month, 1),
      end: Date.UTC(date.getUTCFullYear(), month + 1, 1),
    };
  }
  const ago = Number(first);
  if (!Number.isSafeInteger(ago) || ago > 100_000) return null;
  const weeks = second.startsWith("week");
  const span = weeks ? 7 * DAY : DAY;
  const start = (weeks ? monday : today) - ago * span;
  return { start, end: start + span };
}

/** Parse an explicit time reference from the query in UTC, with an exclusive upper bound. */
export function parseMemoryTime(
  query: string,
  reference = Date.now(),
): MemoryTimeWindow | undefined {
  const today = Math.floor(reference / DAY) * DAY;
  if (!Number.isFinite(today)) return undefined;
  const searchable = query.replace(quoted, (text) =>
    "\u0000".repeat(text.length),
  );
  let open: MemoryTimeWindow | undefined;
  for (const match of searchable.matchAll(phrase)) {
    const [, relation, bound, iso, month, relative] = match;
    const target = bound ?? iso ?? month ?? relative;
    const boundary =
      dateBoundary(target, today) ?? relativeBoundary(target, today);
    if (!boundary) continue;
    const matched = [{ index: match.index, text: match[0] }];
    const modifier = relation?.toLowerCase();
    if (modifier === "since" || modifier === "before") {
      const from = modifier === "since" ? boundary.start : null;
      const to = modifier === "before" ? boundary.start : null;
      open = {
        from:
          from === null
            ? (open?.from ?? null)
            : Math.max(open?.from ?? from, from),
        to: to === null ? (open?.to ?? null) : Math.min(open?.to ?? to, to),
        matched: [...(open?.matched ?? []), ...matched],
      };
      continue;
    }
    if (!open) return { from: boundary.start, to: boundary.end, matched };
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
