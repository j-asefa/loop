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
  `(?<![\\p{L}\\p{N}_./+@$-])(?:(since|before)\\s+(${ISO}|${NAMED_MONTH}|${RELATIVE})|on\\s+(${ISO})|in\\s+(${NAMED_MONTH})|(?:from\\s+)?(${RELATIVE})|(${ISO}|${NAMED_MONTH}))(?![\\p{L}\\p{N}_/+@$]|[.-][\\p{L}\\p{N}_]|['’][\\p{L}]|\\()`,
  "giu",
);
function maskFences(query: string) {
  const markers = /^ {0,3}(`{3,}|~{3,})([^\n]*)/gm;
  const parts: string[] = [];
  let fence: { marker: string; start: number } | undefined;
  let end = 0;
  for (const match of query.matchAll(markers)) {
    const marker = match[1];
    if (!fence) {
      if (marker[0] === "`" && match[2].includes("`")) continue;
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

function maskInlineLiterals(query: string) {
  const limits = new Map<number, number>();
  const codeRuns = [...query.matchAll(/`+|\u0000+/g)];
  const nextCode = new Map<number, number>();
  for (const run of codeRuns.reverse()) {
    if (run[0][0] === "\u0000") {
      nextCode.clear();
      continue;
    }
    const width = run[0].length;
    const closing = nextCode.get(width);
    if (closing !== undefined) limits.set(run.index, closing);
    nextCode.set(width, run.index + width);
  }

  const quotes = [...query.matchAll(/\\[^`\n\r\u0000]|["'“”‘’\n\r\u0000]/g)];
  const nextQuote = new Map<string, number>();
  for (const quote of quotes.reverse()) {
    const [mark] = quote;
    if (mark.length > 1 || mark === "\n" || mark === "\r") continue;
    if (mark === "\u0000") {
      nextQuote.clear();
      continue;
    }
    if (
      (mark === "'" || mark === "’") &&
      /[\p{L}\p{N}]/u.test(query[quote.index - 1] ?? "") &&
      /[\p{L}\p{N}]/u.test(query[quote.index + 1] ?? "")
    )
      continue;
    const closing = nextQuote.get(
      mark === "“" ? "”" : mark === "‘" ? "’" : mark,
    );
    if (
      closing !== undefined &&
      mark !== "”" &&
      mark !== "’" &&
      (mark !== "'" || !/[\p{L}\p{N}]/u.test(query[quote.index - 1] ?? ""))
    )
      limits.set(quote.index, closing);
    nextQuote.set(mark, quote.index + 1);
  }

  // A protected span is owned by its first matched opener. Delimiters
  // inside it cannot consume text beyond its closing delimiter.
  const parts: string[] = [];
  let end = 0;
  for (let index = 0; index < query.length; index++) {
    const limit = limits.get(index);
    if (limit === undefined) continue;
    parts.push(query.slice(end, index), "\u0000".repeat(limit - index));
    end = limit;
    index = limit - 1;
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

function classifyMemoryTime(
  query: string,
  reference = Date.now(),
): MemoryTimeWindow | null | undefined {
  const today = Math.floor(reference / DAY) * DAY;
  if (!Number.isFinite(today)) return undefined;
  const searchable = maskInlineLiterals(maskFences(query));
  const matched: NonNullable<MemoryTimeWindow["matched"]> = [];
  let from: number | null = null;
  let to: number | null = null;
  let period: { start: number; end: number } | undefined;
  let previousEnd = 0;
  for (const match of searchable.matchAll(phrase)) {
    const [, relation, bound, iso, month, relative, bare] = match;
    const between = searchable.slice(previousEnd, match.index);
    previousEnd = match.index + match[0].length;
    const alternative =
      matched.length > 0 &&
      /\b(?:or|nor)(?:\s+[\p{L}]+){0,4}[\s([{]*$/iu.test(between);
    const exclusionContext = /^from\s/iu.test(match[0])
      ? between + "from"
      : between;
    const exclusion =
      /\b(?:not|except|excluding|without)(?:(?:\s+[\p{L}]+){0,4}\s+(?:from|for|during|of)|\s+(?:anything|everything))?[\s([{]*$/iu.test(
        exclusionContext,
      );
    if (bare && !alternative && !exclusion && !/^\p{L}+\s+\d{4}$/u.test(bare))
      continue;
    const target = bound ?? iso ?? month ?? relative ?? bare;
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
    // A single interval cannot express exclusions or alternative dates.
    if (exclusion || alternative) return null;
    if (modifier === "since") {
      from = Math.max(from ?? boundary.start, boundary.start);
    } else if (modifier === "before") {
      to = Math.min(to ?? boundary.start, boundary.start);
    } else {
      if (
        period &&
        (boundary.start < period.start || boundary.end > period.end)
      )
        return null;
      period = boundary;
      from = Math.max(from ?? boundary.start, boundary.start);
      to = Math.min(to ?? boundary.end, boundary.end);
    }
    matched.push({ index: match.index, text: match[0] });
  }
  return matched.length ? { from, to, matched } : undefined;
}

/** Parse a single inclusive-lower, exclusive-upper UTC window. */
export function parseMemoryTime(query: string, reference = Date.now()) {
  return classifyMemoryTime(query, reference) ?? undefined;
}

/** Includes date expressions that cannot be represented by a single window. */
export function hasMemoryTimeExpression(query: string, reference: number) {
  return classifyMemoryTime(query, reference) !== undefined;
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
