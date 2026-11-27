export const MAX_TRACKED_SNIPPETS = 200;

export type SnippetUsageEntry = {
  count: number;
  lastUsedAt: number;
};

export type SnippetUsageMap = Record<string, SnippetUsageEntry>;

export function snippetUsageKey(content: string): string {
  return content.trim();
}

export function createEmptySnippetUsageMap(): SnippetUsageMap {
  return {};
}

function pruneSnippetUsageMap(map: SnippetUsageMap): SnippetUsageMap {
  const entries = Object.entries(map);
  if (entries.length <= MAX_TRACKED_SNIPPETS) return map;
  entries.sort(([, a], [, b]) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastUsedAt - a.lastUsedAt;
  });
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_SNIPPETS));
}

export function parseSnippetUsageStore(raw: string): SnippetUsageMap {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    const entriesObj =
      obj.entries &&
      typeof obj.entries === "object" &&
      !Array.isArray(obj.entries)
        ? (obj.entries as Record<string, unknown>)
        : obj;
    const next: SnippetUsageMap = {};
    for (const [key, value] of Object.entries(entriesObj)) {
      const normalized = snippetUsageKey(key);
      if (!normalized || !value || typeof value !== "object") continue;
      const entry = value as { count?: unknown; lastUsedAt?: unknown };
      if (
        typeof entry.count !== "number" ||
        !Number.isInteger(entry.count) ||
        entry.count < 0
      ) {
        continue;
      }
      const lastUsedAt =
        typeof entry.lastUsedAt === "number" &&
        Number.isFinite(entry.lastUsedAt) &&
        entry.lastUsedAt >= 0
          ? entry.lastUsedAt
          : 0;
      const existing = next[normalized];
      if (
        !existing ||
        entry.count > existing.count ||
        (entry.count === existing.count && lastUsedAt > existing.lastUsedAt)
      ) {
        next[normalized] = { count: entry.count, lastUsedAt };
      }
    }
    return pruneSnippetUsageMap(next);
  } catch {
    return {};
  }
}

export function serializeSnippetUsageStore(map: SnippetUsageMap): string {
  return JSON.stringify({ v: 1, entries: pruneSnippetUsageMap(map) });
}

export function recordSnippetUseInStore(
  map: SnippetUsageMap,
  content: string,
  serverUseCount = 0,
  now = Date.now(),
): SnippetUsageMap {
  const key = snippetUsageKey(content);
  if (!key) return map;
  const prev = map[key];
  const baseServer =
    typeof serverUseCount === "number" &&
    Number.isFinite(serverUseCount) &&
    serverUseCount > 0
      ? Math.floor(serverUseCount)
      : 0;
  const count = Math.max(prev?.count ?? 0, baseServer) + 1;
  const lastUsedAt = Math.max(prev?.lastUsedAt ?? 0, now);
  return pruneSnippetUsageMap({
    ...map,
    [key]: { count, lastUsedAt },
  });
}

export function sortSnippetsByUsage<
  T extends { content: string; use_count?: number },
>(items: readonly T[], usageMap: SnippetUsageMap): T[] {
  if (items.length <= 1) return [...items];
  return items
    .map((item, index) => {
      const local = usageMap[snippetUsageKey(item.content)];
      const serverCount =
        typeof item.use_count === "number" &&
        Number.isFinite(item.use_count) &&
        item.use_count > 0
          ? Math.floor(item.use_count)
          : 0;
      const count = Math.max(serverCount, local?.count ?? 0);
      const lastUsedAt = local?.lastUsedAt ?? 0;
      return { item, index, count, lastUsedAt };
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export function computeKeyboardInset(
  event:
    | {
        endCoordinates?: {
          height?: number;
          screenY?: number;
        };
      }
    | null
    | undefined,
  windowHeight: number,
  platform: string,
): number {
  const height = event?.endCoordinates?.height ?? 0;
  const screenY = event?.endCoordinates?.screenY;
  if (typeof screenY === "number" && Number.isFinite(screenY)) {
    if (screenY >= windowHeight) return 0;
    if (platform === "android" && screenY > 0) {
      return Math.max(0, Math.round(windowHeight - screenY));
    }
  }
  return Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
}

export function computeQuickSheetLayout({
  windowHeight,
  insetTop,
  insetBottom,
  keyboardInset,
}: {
  windowHeight: number;
  insetTop: number;
  insetBottom: number;
  keyboardInset: number;
}): {
  maxSheetHeight: number;
  maxScrollHeight: number;
  sheetPaddingBottom: number;
} {
  const keyboardVisible = keyboardInset > 0;
  const maxSheetHeight = Math.max(
    200,
    Math.round(windowHeight - insetTop - keyboardInset - 20),
  );
  const sheetPaddingBottom = keyboardVisible
    ? 12
    : Math.max(insetBottom + 14, 22);
  const headerAndChromeHeight = 52 + sheetPaddingBottom;
  const maxScrollHeight = Math.max(120, maxSheetHeight - headerAndChromeHeight);
  return { maxSheetHeight, maxScrollHeight, sheetPaddingBottom };
}
