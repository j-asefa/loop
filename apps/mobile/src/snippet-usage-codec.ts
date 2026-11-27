import { draftWorkspaceBucket } from "./drafts-codec";

export const MAX_TRACKED_SNIPPETS = 200;
export const MAX_SCHEDULED_SEND_ATS = 20;
export const PENDING_SNIPPET_TAP_TTL_MS = 24 * 60 * 60 * 1000;

export type SnippetUseKind = "exact" | "bonus";

export type SnippetUsageEntry = {
  pending: number;
  /** Due timestamps for unconfirmed future scheduled exact sends (consumed only after pending === 0 and sendAt <= now). */
  scheduledSendAts?: number[];
  /** Edited sends that never increment the server's exact-match count; immune to serverDelta. */
  localBonus?: number;
  baseServerCount: number;
  lastUsedAt: number;
};

export type SnippetUsageMap = Record<string, SnippetUsageEntry>;

export function snippetUsageKey(content: string): string {
  // Match SQLite's trim(content, ' '||char(9)||char(10)||char(13)).
  return content.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}

export function resolveSentSnippetAttribution<T extends { content: string }>(
  sentText: string,
  pickedSnippetContent: string | null | undefined,
  snippets: readonly T[],
  fallbackSnippet?: T | null,
): { snippet: T; persistPending: SnippetUseKind } | null {
  const trimmedFinal = snippetUsageKey(sentText);
  if (!trimmedFinal) return null;
  // Prefer an exact snippet match over picked-snippet substring attribution so
  // editing snippet A into verbatim snippet B never credits A locally on top of B on the server.
  const exactMatch =
    snippets.find((s) => snippetUsageKey(s.content) === trimmedFinal) ?? null;
  if (exactMatch) {
    return { snippet: exactMatch, persistPending: "exact" };
  }
  const pickedKey = pickedSnippetContent
    ? snippetUsageKey(pickedSnippetContent)
    : "";
  if (pickedKey && trimmedFinal.includes(pickedKey)) {
    const pickedSnippet =
      snippets.find((s) => snippetUsageKey(s.content) === pickedKey) ??
      fallbackSnippet ??
      ({ content: pickedSnippetContent } as T);
    return { snippet: pickedSnippet, persistPending: "bonus" };
  }
  return null;
}

export function createEmptySnippetUsageMap(): SnippetUsageMap {
  return Object.create(null) as SnippetUsageMap;
}

function normalizeScheduledSendAts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
    )
    .sort((a, b) => a - b)
    .slice(0, MAX_SCHEDULED_SEND_ATS);
}

function isEntryExpired(entry: SnippetUsageEntry, now: number): boolean {
  let anchor = entry.lastUsedAt;
  if (entry.scheduledSendAts?.length) {
    for (const sendAt of entry.scheduledSendAts) {
      if (sendAt > anchor) anchor = sendAt;
    }
  }
  return now - anchor > PENDING_SNIPPET_TAP_TTL_MS;
}

function totalLocalDelta(entry: SnippetUsageEntry): number {
  return (
    entry.pending +
    (entry.scheduledSendAts?.length ?? 0) +
    (entry.localBonus ?? 0)
  );
}

function resolveEntryAgainstServer(
  entry: SnippetUsageEntry,
  serverCount: number,
  now: number,
): {
  pending: number;
  scheduledSendAts: number[];
  localBonus: number;
} {
  if (isEntryExpired(entry, now)) {
    return { pending: 0, scheduledSendAts: [], localBonus: 0 };
  }
  let remainingIncrease = Math.max(0, serverCount - entry.baseServerCount);
  const usedByPending = Math.min(entry.pending, remainingIncrease);
  const pending = entry.pending - usedByPending;
  remainingIncrease -= usedByPending;

  const remainingScheduled: number[] = [];
  for (const sendAt of normalizeScheduledSendAts(entry.scheduledSendAts)) {
    if (remainingIncrease > 0 && sendAt <= now) {
      remainingIncrease -= 1;
    } else {
      remainingScheduled.push(sendAt);
    }
  }
  return {
    pending,
    scheduledSendAts: remainingScheduled,
    localBonus: entry.localBonus ?? 0,
  };
}

function pruneSnippetUsageMap(
  map: SnippetUsageMap,
  now = Date.now(),
): SnippetUsageMap {
  const entries = Object.entries(map).filter(
    ([, entry]) => totalLocalDelta(entry) > 0 && !isEntryExpired(entry, now),
  );
  if (entries.length <= MAX_TRACKED_SNIPPETS) {
    const copy = createEmptySnippetUsageMap();
    for (const [key, entry] of entries) copy[key] = entry;
    return copy;
  }
  entries.sort(([, a], [, b]) => {
    const diff = totalLocalDelta(b) - totalLocalDelta(a);
    if (diff !== 0) return diff;
    return b.lastUsedAt - a.lastUsedAt;
  });
  const pruned = createEmptySnippetUsageMap();
  for (const [key, entry] of entries.slice(0, MAX_TRACKED_SNIPPETS)) {
    pruned[key] = entry;
  }
  return pruned;
}

export function parseSnippetUsageStore(
  raw: string,
  now = Date.now(),
): SnippetUsageMap {
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
      const entry = value as {
        pending?: unknown;
        scheduledSendAts?: unknown;
        pendingAfter?: unknown;
        localBonus?: unknown;
        baseServerCount?: unknown;
        lastUsedAt?: unknown;
      };
      const rawPending =
        typeof entry.pending === "number" &&
        Number.isInteger(entry.pending) &&
        entry.pending >= 0
          ? entry.pending
          : -1;
      const localBonus =
        entry.localBonus === undefined
          ? 0
          : typeof entry.localBonus === "number" &&
              Number.isInteger(entry.localBonus) &&
              entry.localBonus >= 0
            ? entry.localBonus
            : -1;
      if (rawPending < 0 || localBonus < 0) {
        continue;
      }
      let scheduledSendAts = normalizeScheduledSendAts(entry.scheduledSendAts);
      let pending = rawPending;
      // Migrate single-slot pendingAfter if present on an older persisted file.
      if (
        scheduledSendAts.length === 0 &&
        typeof entry.pendingAfter === "number" &&
        Number.isFinite(entry.pendingAfter) &&
        entry.pendingAfter > 0 &&
        pending > 0
      ) {
        scheduledSendAts = Array.from(
          { length: Math.min(pending, MAX_SCHEDULED_SEND_ATS) },
          () => entry.pendingAfter as number,
        );
        pending = 0;
      }
      if (pending + scheduledSendAts.length + localBonus <= 0) {
        continue;
      }
      const baseServerCount =
        typeof entry.baseServerCount === "number" &&
        Number.isInteger(entry.baseServerCount) &&
        entry.baseServerCount >= 0
          ? entry.baseServerCount
          : 0;
      const lastUsedAt =
        typeof entry.lastUsedAt === "number" &&
        Number.isFinite(entry.lastUsedAt) &&
        entry.lastUsedAt >= 0
          ? entry.lastUsedAt
          : 0;
      const candidate: SnippetUsageEntry = {
        pending,
        ...(scheduledSendAts.length > 0 ? { scheduledSendAts } : {}),
        ...(localBonus > 0 ? { localBonus } : {}),
        baseServerCount,
        lastUsedAt,
      };
      if (isEntryExpired(candidate, now)) continue;
      const existing = Object.hasOwn(next, normalized)
        ? next[normalized]
        : undefined;
      if (
        !existing ||
        totalLocalDelta(candidate) > totalLocalDelta(existing) ||
        (totalLocalDelta(candidate) === totalLocalDelta(existing) &&
          lastUsedAt > existing.lastUsedAt)
      ) {
        next[normalized] = candidate;
      }
    }
    return pruneSnippetUsageMap(next, now);
  } catch {
    return createEmptySnippetUsageMap();
  }
}

export function serializeSnippetUsageStore(
  map: SnippetUsageMap,
  now = Date.now(),
): string {
  const entries: Record<string, SnippetUsageEntry> = {};
  for (const [key, entry] of Object.entries(pruneSnippetUsageMap(map, now))) {
    Object.defineProperty(entries, key, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return JSON.stringify({ v: 2, entries });
}

export function recordSnippetUseInStore(
  map: SnippetUsageMap,
  content: string,
  serverUseCount = 0,
  now = Date.now(),
  kind: SnippetUseKind = "exact",
  pendingAfter?: number,
): SnippetUsageMap {
  const key = snippetUsageKey(content);
  if (!key) return map;
  const baseServer =
    typeof serverUseCount === "number" &&
    Number.isFinite(serverUseCount) &&
    serverUseCount > 0
      ? Math.floor(serverUseCount)
      : 0;
  const prev = Object.hasOwn(map, key) ? map[key] : undefined;
  const resolved = prev
    ? resolveEntryAgainstServer(prev, baseServer, now)
    : { pending: 0, scheduledSendAts: [], localBonus: 0 };
  const validScheduledAt =
    kind === "exact" &&
    typeof pendingAfter === "number" &&
    Number.isFinite(pendingAfter) &&
    pendingAfter > 0
      ? pendingAfter
      : undefined;
  const nextPending =
    kind === "exact" && validScheduledAt === undefined
      ? resolved.pending + 1
      : resolved.pending;
  const nextScheduled =
    validScheduledAt !== undefined
      ? [...resolved.scheduledSendAts, validScheduledAt]
          .sort((a, b) => a - b)
          .slice(0, MAX_SCHEDULED_SEND_ATS)
      : resolved.scheduledSendAts;
  const nextBonus =
    kind === "bonus" ? resolved.localBonus + 1 : resolved.localBonus;
  const next = createEmptySnippetUsageMap();
  for (const existingKey of Object.keys(map)) {
    next[existingKey] = map[existingKey];
  }
  next[key] = {
    pending: nextPending,
    ...(nextScheduled.length > 0 ? { scheduledSendAts: nextScheduled } : {}),
    ...(nextBonus > 0 ? { localBonus: nextBonus } : {}),
    baseServerCount: baseServer,
    lastUsedAt: Math.max(prev?.lastUsedAt ?? 0, now),
  };
  return pruneSnippetUsageMap(next, now);
}

export function applyImmediateSnippetUseInStore(
  map: SnippetUsageMap,
  content: string,
  preSendServerCount = 0,
  currentServerCount = 0,
  now = Date.now(),
): { map: SnippetUsageMap; recorded: boolean } {
  const baseline = Math.max(0, Math.floor(preSendServerCount || 0));
  const current = Math.max(0, Math.floor(currentServerCount || 0));
  if (current > baseline) {
    // An overlapping refresh already reflected this send in server counts.
    return { map, recorded: false };
  }
  return {
    map: recordSnippetUseInStore(map, content, current, now, "exact"),
    recorded: true,
  };
}

export function reconcileSnippetUsageWithServer(
  map: SnippetUsageMap,
  items: ReadonlyArray<{ content: string; use_count?: number }>,
  now = Date.now(),
): { map: SnippetUsageMap; changed: boolean } {
  const serverCounts = new Map<string, number>();
  for (const item of items) {
    const key = snippetUsageKey(item.content);
    if (!key) continue;
    const count =
      typeof item.use_count === "number" &&
      Number.isFinite(item.use_count) &&
      item.use_count > 0
        ? Math.floor(item.use_count)
        : 0;
    serverCounts.set(key, count);
  }
  const next = createEmptySnippetUsageMap();
  let changed = false;
  for (const key of Object.keys(map)) {
    const entry = map[key];
    if (totalLocalDelta(entry) <= 0 || isEntryExpired(entry, now)) {
      changed = true;
      continue;
    }
    const serverCount = serverCounts.get(key);
    if (serverCount === undefined) {
      next[key] = entry;
      continue;
    }
    const resolved = resolveEntryAgainstServer(entry, serverCount, now);
    if (
      resolved.pending === 0 &&
      resolved.scheduledSendAts.length === 0 &&
      resolved.localBonus === 0
    ) {
      changed = true;
      continue;
    }
    if (
      resolved.pending !== entry.pending ||
      resolved.scheduledSendAts.length !==
        (entry.scheduledSendAts?.length ?? 0) ||
      serverCount !== entry.baseServerCount
    ) {
      changed = true;
    }
    next[key] = {
      pending: resolved.pending,
      ...(resolved.scheduledSendAts.length > 0
        ? { scheduledSendAts: resolved.scheduledSendAts }
        : {}),
      ...(resolved.localBonus > 0 ? { localBonus: resolved.localBonus } : {}),
      baseServerCount: serverCount,
      lastUsedAt: entry.lastUsedAt,
    };
  }
  return { map: next, changed };
}

export function sortSnippetsByUsage<
  T extends { content: string; use_count?: number; last_used_at?: number },
>(items: readonly T[], usageMap: SnippetUsageMap, now = Date.now()): T[] {
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
      const serverLastUsedAt =
        typeof item.last_used_at === "number" &&
        Number.isFinite(item.last_used_at) &&
        item.last_used_at > 0
          ? item.last_used_at
          : 0;
      const resolved = local
        ? resolveEntryAgainstServer(local, serverCount, now)
        : { pending: 0, scheduledSendAts: [], localBonus: 0 };
      const localCount =
        resolved.pending +
        resolved.scheduledSendAts.length +
        resolved.localBonus;
      const count = serverCount + localCount;
      const lastUsedAt = Math.max(
        serverLastUsedAt,
        localCount > 0 && local ? local.lastUsedAt : 0,
      );
      return { item, index, count, lastUsedAt };
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export type SnippetUsageStorage = {
  readText(bucket: string): Promise<string | null>;
  writeText(bucket: string, raw: string): void;
  deleteFile(bucket: string): void;
};

type PendingUseOp = {
  content: string;
  serverUseCount?: number;
  now: number;
  kind: SnippetUseKind;
  pendingAfter?: number;
};

export function createSnippetUsageStore(storage: SnippetUsageStorage) {
  const memoryBuckets = new Map<string, SnippetUsageMap>();
  const loadedBuckets = new Set<string>();
  const pendingLoads = new Map<string, Promise<SnippetUsageMap>>();
  const pendingOpsByBucket = new Map<string, PendingUseOp[]>();
  const latestServerItems = new Map<
    string,
    ReadonlyArray<{ content: string; use_count?: number }>
  >();
  const bucketEpoch = new Map<string, number>();

  function writeBucketFile(
    bucket: string,
    map: SnippetUsageMap,
    now = Date.now(),
  ): void {
    try {
      const serialized = serializeSnippetUsageStore(map, now);
      if (serialized === '{"v":2,"entries":{}}') {
        storage.deleteFile(bucket);
      } else {
        storage.writeText(bucket, serialized);
      }
    } catch {
      // Best-effort local persistence; never block snippet selection.
    }
  }

  async function ensureBucketLoaded(bucket: string): Promise<SnippetUsageMap> {
    if (loadedBuckets.has(bucket)) {
      return memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap();
    }
    const existingLoad = pendingLoads.get(bucket);
    if (existingLoad) return existingLoad;

    const epochAtStart = bucketEpoch.get(bucket) ?? 0;
    const loadPromise = (async () => {
      let loaded = createEmptySnippetUsageMap();
      try {
        const raw = await storage.readText(bucket);
        if (raw !== null) {
          loaded = parseSnippetUsageStore(raw);
        }
      } catch {
        loaded = createEmptySnippetUsageMap();
      }
      if ((bucketEpoch.get(bucket) ?? 0) !== epochAtStart) {
        return memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap();
      }
      const pending = pendingOpsByBucket.get(bucket);
      pendingOpsByBucket.delete(bucket);
      let merged = loaded;
      let dirty = false;
      if (pending?.length) {
        for (const op of pending) {
          merged = recordSnippetUseInStore(
            merged,
            op.content,
            op.serverUseCount,
            op.now,
            op.kind,
            op.pendingAfter,
          );
        }
        dirty = true;
      }
      const serverSnapshot = latestServerItems.get(bucket);
      if (serverSnapshot) {
        const reconciled = reconcileSnippetUsageWithServer(
          merged,
          serverSnapshot,
        );
        if (reconciled.changed) {
          merged = reconciled.map;
          dirty = true;
        }
      }
      memoryBuckets.set(bucket, merged);
      loadedBuckets.add(bucket);
      if (dirty) {
        writeBucketFile(bucket, merged);
      }
      return merged;
    })().finally(() => {
      if (pendingLoads.get(bucket) === loadPromise) {
        pendingLoads.delete(bucket);
      }
    });
    pendingLoads.set(bucket, loadPromise);
    return loadPromise;
  }

  async function loadSnippetUsage(
    origin: string | null | undefined,
  ): Promise<SnippetUsageMap> {
    if (!origin) return createEmptySnippetUsageMap();
    return ensureBucketLoaded(draftWorkspaceBucket(origin));
  }

  function recordSnippetUse(
    origin: string | null | undefined,
    content: string,
    serverUseCount?: number,
    now = Date.now(),
    kind: SnippetUseKind = "exact",
    pendingAfter?: number,
  ): SnippetUsageMap {
    if (!origin) return createEmptySnippetUsageMap();
    const bucket = draftWorkspaceBucket(origin);
    const current = memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap();
    const next = recordSnippetUseInStore(
      current,
      content,
      serverUseCount,
      now,
      kind,
      pendingAfter,
    );
    memoryBuckets.set(bucket, next);
    if (!loadedBuckets.has(bucket)) {
      const queue = pendingOpsByBucket.get(bucket) ?? [];
      queue.push({ content, serverUseCount, now, kind, pendingAfter });
      pendingOpsByBucket.set(bucket, queue);
      void ensureBucketLoaded(bucket);
      return next;
    }
    writeBucketFile(bucket, next, now);
    return next;
  }

  function reconcileSnippetUsage(
    origin: string | null | undefined,
    items: ReadonlyArray<{ content: string; use_count?: number }>,
    now = Date.now(),
  ): SnippetUsageMap {
    if (!origin) return createEmptySnippetUsageMap();
    const bucket = draftWorkspaceBucket(origin);
    latestServerItems.set(bucket, items);
    const current = memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap();
    const { map: next, changed } = reconcileSnippetUsageWithServer(
      current,
      items,
      now,
    );
    if (!changed) return current;
    memoryBuckets.set(bucket, next);
    if (loadedBuckets.has(bucket)) {
      writeBucketFile(bucket, next, now);
    }
    return next;
  }

  function clearWorkspaceSnippetUsage(origin: string | null | undefined): void {
    if (!origin) return;
    const bucket = draftWorkspaceBucket(origin);
    bucketEpoch.set(bucket, (bucketEpoch.get(bucket) ?? 0) + 1);
    memoryBuckets.delete(bucket);
    loadedBuckets.delete(bucket);
    pendingLoads.delete(bucket);
    pendingOpsByBucket.delete(bucket);
    latestServerItems.delete(bucket);
    try {
      storage.deleteFile(bucket);
    } catch {
      // ignore
    }
  }

  return {
    loadSnippetUsage,
    recordSnippetUse,
    reconcileSnippetUsage,
    clearWorkspaceSnippetUsage,
  };
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
