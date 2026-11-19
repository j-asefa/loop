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
  `(?<![\\p{L}\\p{N}_./+@$-])(?:(since|before)\\s+(${ISO}|${NAMED_MONTH}|${RELATIVE})|on\\s+(${ISO})|in\\s+(${NAMED_MONTH})|(${RELATIVE}))(?![\\p{L}\\p{N}_/+@$]|[.-][\\p{L}\\p{N}_])`,
  "giu",
);
const quoted =
  /"(?:\\.|[^"\\\n])*"|(?<![\p{L}\p{N}])'(?:\\.|[^'\\\n])*'|“[^”\n]*”|‘[^’\n]*’/gu;

function maskFences(query: string) {
  const markers = /^ {0,3}(`{3,}|~{3,})([^\n]*)/gm;
  const parts: string[] = [];
  let fence: { marker: string; start: number } | undefined;
  let end = 0;
  for (const match of query.matchAll(markers)) {
    const marker = match[1];
    if (!fence) {
      fence = { marker, start: match.index };
    } else if (
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      !match[2].trim()
    ) {
      const limit = match.index + match[0].length;
      parts.push(
        query.slice(end, fence.start),
        "\u0000".repeat(limit - fence.start),
      );
      end = limit;
      fence = undefined;
    }
  }
  if (fence)
    parts.push(
      query.slice(end, fence.start),
      "\u0000".repeat(query.length - fence.start),
    );
  else parts.push(query.slice(end));
  return parts.join("");
}

function maskInlineCode(query: string) {
  const runs = [...query.matchAll(/`+|\u0000+/g)];
  const closer = new Map<number, number>();
  const next = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const text = runs[index][0];
    if (text[0] === "\u0000") {
      next.clear();
      continue;
    }
    const closing = next.get(text.length);
    if (closing !== undefined) closer.set(index, closing);
    next.set(text.length, index);
  }
  const parts: string[] = [];
  let end = 0;
  for (let index = 0; index < runs.length; index++) {
    const closing = closer.get(index);
    if (closing === undefined) continue;
    const start = runs[index].index;
    const limit = runs[closing].index + runs[closing][0].length;
    parts.push(query.slice(end, start), "\u0000".repeat(limit - start));
    end = limit;
    index = closing;
  }
  parts.push(query.slice(end));
  return parts.join("");
}

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
  const searchable = maskInlineCode(maskFences(query)).replace(quoted, (text) =>
    "\u0000".repeat(text.length),
  );
  const matched: NonNullable<MemoryTimeWindow["matched"]> = [];
  let from: number | null = null;
  let to: number | null = null;
  let period: { start: number; end: number } | undefined;
  for (const match of searchable.matchAll(phrase)) {
    const [, relation, bound, iso, month, relative] = match;
    const target = bound ?? iso ?? month ?? relative;
    const boundary =
      dateBoundary(target, today) ?? relativeBoundary(target, today);
    if (!boundary) continue;
    const modifier = relation?.toLowerCase();
    if (
      relation &&
      MONTHS.some((name) => name.toLowerCase() === target.toLowerCase())
    ) {
      const after = searchable.slice(match.index + match[0].length);
      // A bare month can also be a person's name. Leave clauses such as
      // "since May joined" searchable. A month and year is unambiguous.
      if (
        /^\s+(?!(?:and|or|from|about|for|on|in|to|at)\b)[\p{L}]/iu.test(after)
      )
        continue;
    }
    if (modifier === "since") {
      from = Math.max(from ?? boundary.start, boundary.start);
    } else if (modifier === "before") {
      to = Math.min(to ?? boundary.start, boundary.start);
    } else {
      if (
        period &&
        (boundary.start < period.start || boundary.end > period.end)
      )
        continue;
      period = boundary;
      from = Math.max(from ?? boundary.start, boundary.start);
      to = Math.min(to ?? boundary.end, boundary.end);
    }
    matched.push({ index: match.index, text: match[0] });
  }
  return matched.length ? { from, to, matched } : undefined;
}

export function withoutMemoryTime(query: string, window?: MemoryTimeWindow) {
  if (!window?.matched?.length) return query;
  const parts: string[] = [];
  let end = 0;
  for (const match of window.matched) {
    parts.push(query.slice(end, match.index), " ");
    end = match.index + match.text.length;
  }
  parts.push(query.slice(end));
  return parts.join("");
}
