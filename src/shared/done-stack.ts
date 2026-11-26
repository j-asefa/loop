export type StackableCardRow<TItem> = {
  key: string;
  item: TItem;
  isManualGroup: boolean;
  conversationKey: string;
  unread: boolean;
};

export type StackedCardEntry<TItem> = {
  /** Key of the top (newest) card or manual group. */
  key: string;
  /** Top card shown on the Feed surface. */
  top: TItem;
  /** All discrete cards in this stack, newest first (index 0 === top). */
  cards: TItem[];
  /** Number of unread cards in the stack. */
  unreadCount: number;
  /** Whether this row is a user-curated Saved Group (not auto-stacked). */
  isManualGroup: boolean;
};

/**
 * Collapses multiple standalone Done cards from the same (source, conversation)
 * into a single visual stack ordered by its newest card (index 0).
 * User-curated Saved Groups remain distinct unstacked rows.
 */
export function stackDoneCards<TItem>(
  rows: readonly StackableCardRow<TItem>[],
): StackedCardEntry<TItem>[] {
  const result: StackedCardEntry<TItem>[] = [];
  const stacksByConversation = new Map<string, StackedCardEntry<TItem>>();

  for (const row of rows) {
    if (row.isManualGroup) {
      result.push({
        key: row.key,
        top: row.item,
        cards: [row.item],
        unreadCount: row.unread ? 1 : 0,
        isManualGroup: true,
      });
      continue;
    }
    const existing = stacksByConversation.get(row.conversationKey);
    if (existing) {
      existing.cards.push(row.item);
      if (row.unread) existing.unreadCount += 1;
      continue;
    }
    const entry: StackedCardEntry<TItem> = {
      key: row.key,
      top: row.item,
      cards: [row.item],
      unreadCount: row.unread ? 1 : 0,
      isManualGroup: false,
    };
    stacksByConversation.set(row.conversationKey, entry);
    result.push(entry);
  }

  return result;
}

export type SearchableThreadCard = {
  id: string;
  title: string;
  prompt?: string;
  body: string;
  createdAt: number;
  saved: boolean;
  unread: boolean;
};

export type HighlightSegment = {
  text: string;
  hit: boolean;
};

export type ThreadCardSearchHit = {
  cardId: string;
  index: number;
  title: string;
  createdAt: number;
  saved: boolean;
  unread: boolean;
  snippet: HighlightSegment[];
};

const SNIPPET_RADIUS = 48;
const SNIPPET_MAX_CHARS = 128;

function tokenizeQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function highlightSnippet(
  source: string,
  tokens: readonly string[],
): HighlightSegment[] {
  const clean = collapseWhitespace(source);
  if (!clean) return [];
  const lower = clean.toLowerCase();

  let firstMatch = -1;
  for (const token of tokens) {
    const pos = lower.indexOf(token);
    if (pos !== -1 && (firstMatch === -1 || pos < firstMatch)) firstMatch = pos;
  }

  let start = 0;
  let end = Math.min(clean.length, SNIPPET_MAX_CHARS);
  if (firstMatch !== -1 && firstMatch > SNIPPET_RADIUS) {
    start = Math.max(0, firstMatch - SNIPPET_RADIUS);
    const space = clean.indexOf(" ", start);
    if (space !== -1 && space < firstMatch) start = space + 1;
    end = Math.min(clean.length, start + SNIPPET_MAX_CHARS);
  }
  const slice = clean.slice(start, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";

  if (!tokens.length) {
    return [{ text: prefix + slice + suffix, hit: false }];
  }

  const lowerSlice = slice.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const token of tokens) {
    let from = 0;
    while (from < lowerSlice.length) {
      const idx = lowerSlice.indexOf(token, from);
      if (idx === -1) break;
      spans.push([idx, idx + token.length]);
      from = idx + token.length;
    }
  }
  if (!spans.length) {
    return [{ text: prefix + slice + suffix, hit: false }];
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const segments: HighlightSegment[] = [];
  if (prefix) segments.push({ text: prefix, hit: false });
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) segments.push({ text: slice.slice(cursor, s), hit: false });
    segments.push({ text: slice.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < slice.length)
    segments.push({ text: slice.slice(cursor), hit: false });
  if (suffix) segments.push({ text: suffix, hit: false });
  return segments;
}

/**
 * Searches discrete result cards in a thread carousel. Every token in `query`
 * must match across the card's title, prompt, or body. Results preserve
 * carousel slide order (newest first) so Prev/Next stepping matches swiping.
 */
export function searchThreadCards(
  cards: readonly SearchableThreadCard[],
  query: string,
): ThreadCardSearchHit[] {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [];

  const hits: ThreadCardSearchHit[] = [];
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    const combined =
      `${card.title}\n${card.prompt ?? ""}\n${card.body}`.toLowerCase();
    if (!tokens.every((token) => combined.includes(token))) continue;

    // Prefer highlighting from the body when it contains a match; fall back to prompt/title.
    const bodyLower = card.body.toLowerCase();
    const snippetSource = tokens.some((token) => bodyLower.includes(token))
      ? card.body
      : card.prompt &&
          tokens.some((token) => card.prompt!.toLowerCase().includes(token))
        ? card.prompt
        : card.title;

    hits.push({
      cardId: card.id,
      index,
      title: card.title,
      createdAt: card.createdAt,
      saved: card.saved,
      unread: card.unread,
      snippet: highlightSnippet(snippetSource, tokens),
    });
  }
  return hits;
}

export type CarouselCardHeader = {
  /** Headline rendered at the top of the card. */
  title: string;
  /** True when the title is long enough to step down typography slightly (>65 chars). */
  compactTitle: boolean;
  /**
   * Optional user prompt shown in a compact expandable "You asked" quote chip
   * above the answer — populated when the prompt was long/multi-line or when a
   * concise Markdown heading from the answer was promoted as the headline.
   */
  promptQuote?: string;
  /** Where the resolved card title came from. */
  titleSource: "prompt" | "heading" | "fallback";
};

const COMPACT_TITLE_THRESHOLD = 65;
const LONG_PROMPT_THRESHOLD = 120;
const MAX_PROMOTED_HEADING_CHARS = 100;

function extractLeadingHeading(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const match = /^#{1,3}\s+(.+?)\s*#*$/.exec(firstLine);
  if (!match) return undefined;
  const cleaned = match[1].trim();
  if (!cleaned || cleaned.length > MAX_PROMOTED_HEADING_CHARS) return undefined;
  return cleaned;
}

function stripHeadingPrefix(line: string): string {
  return line.replace(/^#+\s*/, "").trim();
}

/**
 * Resolves a carousel card's headline and optional "You asked" quote block so
 * short prompts stay punchy, long multi-line prompts with headed answers don't
 * stack giant paragraphs above the fold, and long single-paragraph prompts
 * remain clean and expandable.
 */
export function resolveCarouselCardHeader(input: {
  prompt?: string;
  body?: string;
  fallback: string;
}): CarouselCardHeader {
  const rawPrompt = input.prompt?.trim() ?? "";
  const bodyHeading = extractLeadingHeading(input.body);
  const fallback =
    stripHeadingPrefix(
      input.fallback
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "",
    ) || "Result";

  if (!rawPrompt) {
    const title = bodyHeading ?? fallback;
    return {
      title,
      compactTitle: title.length > COMPACT_TITLE_THRESHOLD,
      titleSource: bodyHeading ? "heading" : "fallback",
    };
  }

  const promptLines = rawPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = stripHeadingPrefix(promptLines[0] ?? "") || fallback;
  const isMultiLine = promptLines.length > 1;
  const isLongPrompt =
    collapseWhitespace(rawPrompt).length > LONG_PROMPT_THRESHOLD || isMultiLine;

  if (isLongPrompt && bodyHeading) {
    return {
      title: bodyHeading,
      compactTitle: bodyHeading.length > COMPACT_TITLE_THRESHOLD,
      promptQuote: rawPrompt,
      titleSource: "heading",
    };
  }

  return {
    title: firstLine,
    compactTitle: firstLine.length > COMPACT_TITLE_THRESHOLD,
    promptQuote: isMultiLine ? rawPrompt : undefined,
    titleSource: "prompt",
  };
}

/**
 * Finds the next or previous matching slide index from `currentIndex`,
 * wrapping cleanly around the ends of `hits`.
 */
export function stepMatchIndex(
  hits: readonly ThreadCardSearchHit[],
  currentIndex: number,
  direction: "prev" | "next",
): number | null {
  if (!hits.length) return null;
  const currentPos = hits.findIndex((hit) => hit.index === currentIndex);
  if (currentPos !== -1) {
    const nextPos =
      direction === "next"
        ? (currentPos + 1) % hits.length
        : (currentPos - 1 + hits.length) % hits.length;
    return hits[nextPos].index;
  }
  if (direction === "next") {
    const after = hits.find((hit) => hit.index > currentIndex);
    return (after ?? hits[0]).index;
  }
  for (let i = hits.length - 1; i >= 0; i--) {
    if (hits[i].index < currentIndex) return hits[i].index;
  }
  return hits[hits.length - 1].index;
}
