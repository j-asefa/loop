export const MAX_TRACKED_SNIPPETS = 200;

export type SnippetUsageEntry = {
  count: number;
  lastUsedAt: number;
};

export type SnippetUsageMap = Record<string, SnippetUsageEntry>;

export function snippetUsageKey(content: string): string {
  // Match SQLite's trim(content, ' '||char(9)||char(10)||char(13)).
  return content.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}

export function createEmptySnippetUsageMap(): SnippetUsageMap {
  return Object.create(null) as SnippetUsageMap;
}

function pruneSnippetUsageMap(map: SnippetUsageMap): SnippetUsageMap {
  const entries = Object.entries(map);
  if (entries.length <= MAX_TRACKED_SNIPPETS) {
    const copy = createEmptySnippetUsageMap();
    for (const [key, entry] of entries) copy[key] = entry;
    return copy;
  }
  entries.sort(([, a], [, b]) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastUsedAt - a.lastUsedAt;
  });
  const pruned = createEmptySnippetUsageMap();
  for (const [key, entry] of entries.slice(0, MAX_TRACKED_SNIPPETS)) {
    pruned[key] = entry;
  }
  return pruned;
}

export function parseSnippetUsageStore(raw: string): SnippetUsageMap {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return createEmptySnippetUsageMap();
    }
    const obj = parsed as Record<string, unknown>;
    const entriesObj =
      obj.entries &&
      typeof obj.entries === "object" &&
      !Array.isArray(obj.entries)
        ? (obj.entries as Record<string, unknown>)
        : obj;
    const next = createEmptySnippetUsageMap();
    for (const key of Object.keys(entriesObj)) {
      const value = entriesObj[key];
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
      const existing = Object.hasOwn(next, normalized)
        ? next[normalized]
        : undefined;
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
    return createEmptySnippetUsageMap();
  }
}

export function serializeSnippetUsageStore(map: SnippetUsageMap): string {
  const entries: Record<string, SnippetUsageEntry> = {};
  for (const [key, entry] of Object.entries(pruneSnippetUsageMap(map))) {
    Object.defineProperty(entries, key, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return JSON.stringify({ v: 1, entries });
}

export function recordSnippetUseInStore(
  map: SnippetUsageMap,
  content: string,
  serverUseCount = 0,
  now = Date.now(),
): SnippetUsageMap {
  const key = snippetUsageKey(content);
  if (!key) return map;
  const prev = Object.hasOwn(map, key) ? map[key] : undefined;
  const baseServer =
    typeof serverUseCount === "number" &&
    Number.isFinite(serverUseCount) &&
    serverUseCount > 0
      ? Math.floor(serverUseCount)
      : 0;
  const count = Math.max(prev?.count ?? 0, baseServer) + 1;
  const lastUsedAt = Math.max(prev?.lastUsedAt ?? 0, now);
  const next = createEmptySnippetUsageMap();
  for (const existingKey of Object.keys(map)) {
    next[existingKey] = map[existingKey];
  }
  next[key] = { count, lastUsedAt };
  return pruneSnippetUsageMap(next);
}

export function mergeSnippetUsageMaps(
  disk: SnippetUsageMap,
  memory: SnippetUsageMap,
): SnippetUsageMap {
  const merged = createEmptySnippetUsageMap();
  for (const key of Object.keys(disk)) {
    merged[key] = disk[key];
  }
  for (const key of Object.keys(memory)) {
    const entry = memory[key];
    const existing = Object.hasOwn(merged, key) ? merged[key] : undefined;
    if (!existing) {
      merged[key] = entry;
      continue;
    }
    merged[key] = {
      count: Math.max(existing.count, entry.count),
      lastUsedAt: Math.max(existing.lastUsedAt, entry.lastUsedAt),
    };
  }
  return pruneSnippetUsageMap(merged);
}

export function sortSnippetsByUsage<
  T extends { content: string; use_count?: number },
>(items: readonly T[], usageMap: SnippetUsageMap): T[] {
  if (items.length <= 1) return [...items];
  return items
    .map((item, index) => {
      const key = snippetUsageKey(item.content);
      const local = Object.hasOwn(usageMap, key) ? usageMap[key] : undefined;
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
  containerHeight: number,
  platform: string,
): number {
  const height = event?.endCoordinates?.height ?? 0;
  const screenY = event?.endCoordinates?.screenY;
  if (typeof screenY === "number" && Number.isFinite(screenY)) {
    if (screenY >= containerHeight) return 0;
    if (platform === "android" && screenY > 0) {
      return Math.max(0, Math.round(containerHeight - screenY));
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
    0,
    Math.round(windowHeight - insetTop - keyboardInset - 12),
  );
  const sheetPaddingBottom = keyboardVisible
    ? 12
    : Math.max(insetBottom + 14, 22);
  const headerAndChromeHeight = 52 + sheetPaddingBottom;
  const maxScrollHeight = Math.max(0, maxSheetHeight - headerAndChromeHeight);
  return { maxSheetHeight, maxScrollHeight, sheetPaddingBottom };
}
