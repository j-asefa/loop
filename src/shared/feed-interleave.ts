import type { StreamItem } from "./stream-item.js";

/** Source filter for Loop's unified Feed. Email plugs in here later. */
export type FeedSourceFilter = "all" | "agents" | "feeds";

export type FeedReadFilter = "all" | "unread" | "read";

export type AgentFeedEntry<TAgent> = {
  item: TAgent;
  key: string;
  unread?: boolean;
};

export type InterleavedFeedRow<TAgent> =
  | { kind: "agent"; item: TAgent; key: string }
  | { kind: "stream"; item: StreamItem; key: string };

export type InterleaveOptions = {
  /** Max external stream items woven between two consecutive agent cards. */
  ratio?: number;
  /** Max items per sourceId within each diversity pass so one noisy feed never dominates. */
  maxPerSourcePerPass?: number;
  /** Maximum total external stream items placed into the mixed "all" view. */
  maxMixedStreams?: number;
};

export type InterleaveResult<TAgent> = {
  rows: InterleavedFeedRow<TAgent>[];
  /** True when more eligible stream items exist beyond maxMixedStreams in "all" mode. */
  hasMoreStreams: boolean;
};

function compareStreamsNewestFirst(a: StreamItem, b: StreamItem): number {
  return b.timestamp - a.timestamp || a.id.localeCompare(b.id);
}

/**
 * Orders stream items with per-source diversity caps in passes so no single
 * high-volume feed (e.g., Hacker News) dominates the top of the mixed Feed,
 * while avoiding consecutive cards from the same source whenever alternatives exist.
 */
export function paceStreamItems(
  items: readonly StreamItem[],
  maxPerSourcePerPass = 2,
): StreamItem[] {
  const cap = Math.max(1, Math.floor(maxPerSourcePerPass));
  const highSignal = items
    .filter((item) => item.highSignal)
    .sort(compareStreamsNewestFirst);
  const regular = items
    .filter((item) => !item.highSignal)
    .sort(compareStreamsNewestFirst);

  // Group regular items by source while preserving newest-first order per source.
  const bySource = new Map<string, StreamItem[]>();
  for (const item of regular) {
    const bucket = bySource.get(item.sourceId);
    if (bucket) bucket.push(item);
    else bySource.set(item.sourceId, [item]);
  }

  const orderedRegular: StreamItem[] = [];
  const cursors = new Map<string, number>();
  for (const sourceId of bySource.keys()) cursors.set(sourceId, 0);

  let remaining = regular.length;
  let lastSourceId: string | null = null;

  while (remaining > 0) {
    // Each pass allows at most `cap` items per source, selecting the newest
    // available candidate across eligible sources and preferring a different
    // source than the immediately preceding card when possible.
    const passCounts = new Map<string, number>();
    let pickedInPass = true;
    while (pickedInPass && remaining > 0) {
      pickedInPass = false;
      let best: StreamItem | null = null;
      let bestFallback: StreamItem | null = null;

      for (const [sourceId, list] of bySource) {
        const idx = cursors.get(sourceId) ?? 0;
        if (idx >= list.length) continue;
        if ((passCounts.get(sourceId) ?? 0) >= cap) continue;
        const candidate = list[idx];
        if (sourceId !== lastSourceId) {
          if (!best || compareStreamsNewestFirst(candidate, best) < 0)
            best = candidate;
        } else if (
          !bestFallback ||
          compareStreamsNewestFirst(candidate, bestFallback) < 0
        ) {
          bestFallback = candidate;
        }
      }

      const chosen = best ?? bestFallback;
      if (!chosen) break;
      pickedInPass = true;
      orderedRegular.push(chosen);
      cursors.set(chosen.sourceId, (cursors.get(chosen.sourceId) ?? 0) + 1);
      passCounts.set(
        chosen.sourceId,
        (passCounts.get(chosen.sourceId) ?? 0) + 1,
      );
      lastSourceId = chosen.sourceId;
      remaining--;
    }
  }

  return [...highSignal, ...orderedRegular];
}

/**
 * Combines agent Done rows and external StreamItems into Loop's unified Feed.
 *
 * - `source === "agents"`: returns agent rows unchanged.
 * - `source === "feeds"`: returns all read-filter-matching stream items strictly newest-first.
 * - `source === "all"`:
 *   - Uses unread stream items when `readFilter === "all"` or `"unread"` (so old read RSS
 *     items do not clutter the mixed Feed), and read stream items when `readFilter === "read"`.
 *   - Leads with the top agent card when present, weaves in high-signal items and paced
 *     stream items at `ratio` per agent card, and caps total mixed stream items at
 *     `maxMixedStreams` (signalling `hasMoreStreams` so the UI can link to `Feeds`).
 */
export function interleaveFeed<TAgent>(
  agents: readonly AgentFeedEntry<TAgent>[],
  streams: readonly StreamItem[],
  source: FeedSourceFilter,
  readFilter: FeedReadFilter = "all",
  options: InterleaveOptions = {},
): InterleaveResult<TAgent> {
  if (source === "agents") {
    return {
      rows: agents.map((entry) => ({
        kind: "agent" as const,
        item: entry.item,
        key: entry.key,
      })),
      hasMoreStreams: false,
    };
  }

  if (source === "feeds") {
    const filtered = streams.filter((item) =>
      readFilter === "unread"
        ? !item.read
        : readFilter === "read"
          ? item.read
          : true,
    );
    const sorted = [...filtered].sort(compareStreamsNewestFirst);
    return {
      rows: sorted.map((item) => ({
        kind: "stream" as const,
        item,
        key: item.id,
      })),
      hasMoreStreams: false,
    };
  }

  // source === "all"
  const eligibleStreams = streams.filter((item) =>
    readFilter === "read" ? item.read : !item.read,
  );
  if (!eligibleStreams.length) {
    return {
      rows: agents.map((entry) => ({
        kind: "agent" as const,
        item: entry.item,
        key: entry.key,
      })),
      hasMoreStreams: false,
    };
  }

  const ratio = Math.max(1, Math.floor(options.ratio ?? 2));
  const maxPerSourcePerPass = Math.max(
    1,
    Math.floor(options.maxPerSourcePerPass ?? 2),
  );
  const maxMixedStreams = Math.max(
    1,
    Math.floor(options.maxMixedStreams ?? 24),
  );

  const paced = paceStreamItems(eligibleStreams, maxPerSourcePerPass);
  const limitedStreams = paced.slice(0, maxMixedStreams);
  const hasMoreStreams = paced.length > limitedStreams.length;

  if (!agents.length) {
    return {
      rows: limitedStreams.map((item) => ({
        kind: "stream" as const,
        item,
        key: item.id,
      })),
      hasMoreStreams,
    };
  }

  const rows: InterleavedFeedRow<TAgent>[] = [];
  let streamIndex = 0;

  for (let i = 0; i < agents.length; i++) {
    const entry = agents[i];
    rows.push({ kind: "agent", item: entry.item, key: entry.key });

    // After the very first agent card, surface any high-signal items right away.
    if (i === 0) {
      while (
        streamIndex < limitedStreams.length &&
        limitedStreams[streamIndex].highSignal
      ) {
        const s = limitedStreams[streamIndex++];
        rows.push({ kind: "stream", item: s, key: s.id });
      }
    }

    // Weave up to `ratio` stream items after each agent card.
    for (
      let slot = 0;
      slot < ratio && streamIndex < limitedStreams.length;
      slot++
    ) {
      const s = limitedStreams[streamIndex++];
      rows.push({ kind: "stream", item: s, key: s.id });
    }
  }

  // Append remaining capped stream items after the last agent card.
  while (streamIndex < limitedStreams.length) {
    const s = limitedStreams[streamIndex++];
    rows.push({ kind: "stream", item: s, key: s.id });
  }

  return { rows, hasMoreStreams };
}
