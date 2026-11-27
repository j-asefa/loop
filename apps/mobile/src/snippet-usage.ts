import { File as ExpoFile, Paths } from "expo-file-system";
import { draftWorkspaceBucket } from "./drafts-codec";
import {
  createEmptySnippetUsageMap,
  parseSnippetUsageStore,
  recordSnippetUseInStore,
  serializeSnippetUsageStore,
  type SnippetUsageMap,
} from "./snippet-usage-codec";

export {
  computeKeyboardInset,
  computeQuickSheetLayout,
  recordSnippetUseInStore,
  sortSnippetsByUsage,
  type SnippetUsageEntry,
  type SnippetUsageMap,
} from "./snippet-usage-codec";

const memoryBuckets = new Map<string, SnippetUsageMap>();
const loadedBuckets = new Set<string>();
const pendingLoads = new Map<string, Promise<SnippetUsageMap>>();
const bucketEpoch = new Map<string, number>();

function usageFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.cache, `loop-snippet-usage-${bucket}.json`);
}

function mergeUsageMaps(
  disk: SnippetUsageMap,
  memory: SnippetUsageMap,
): SnippetUsageMap {
  const merged: SnippetUsageMap = { ...disk };
  for (const [key, entry] of Object.entries(memory)) {
    const existing = merged[key];
    if (!existing) {
      merged[key] = entry;
      continue;
    }
    merged[key] = {
      count: Math.max(existing.count, entry.count),
      lastUsedAt: Math.max(existing.lastUsedAt, entry.lastUsedAt),
    };
  }
  return merged;
}

export async function loadSnippetUsage(
  origin: string | null | undefined,
): Promise<SnippetUsageMap> {
  if (!origin) return createEmptySnippetUsageMap();
  const bucket = draftWorkspaceBucket(origin);
  if (loadedBuckets.has(bucket)) {
    return memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap();
  }
  const existingLoad = pendingLoads.get(bucket);
  if (existingLoad) return existingLoad;

  const epochAtStart = bucketEpoch.get(bucket) ?? 0;
  const loadPromise = (async () => {
    let loaded = createEmptySnippetUsageMap();
    try {
      const file = usageFileForBucket(bucket);
      if (file.exists) {
        loaded = parseSnippetUsageStore(await file.text());
      }
    } catch {
      loaded = createEmptySnippetUsageMap();
    }
    if ((bucketEpoch.get(bucket) ?? 0) !== epochAtStart) {
      return memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap();
    }
    const merged = mergeUsageMaps(
      loaded,
      memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap(),
    );
    memoryBuckets.set(bucket, merged);
    loadedBuckets.add(bucket);
    pendingLoads.delete(bucket);
    return merged;
  })();
  pendingLoads.set(bucket, loadPromise);
  return loadPromise;
}

export function recordSnippetUse(
  origin: string | null | undefined,
  content: string,
  serverUseCount?: number,
): SnippetUsageMap {
  if (!origin) return createEmptySnippetUsageMap();
  const bucket = draftWorkspaceBucket(origin);
  const current = memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap();
  const next = recordSnippetUseInStore(current, content, serverUseCount);
  memoryBuckets.set(bucket, next);
  try {
    usageFileForBucket(bucket).write(serializeSnippetUsageStore(next));
  } catch {
    // Best-effort local persistence; never block snippet selection.
  }
  return next;
}

export function clearWorkspaceSnippetUsage(
  origin: string | null | undefined,
): void {
  if (!origin) return;
  const bucket = draftWorkspaceBucket(origin);
  bucketEpoch.set(bucket, (bucketEpoch.get(bucket) ?? 0) + 1);
  memoryBuckets.delete(bucket);
  loadedBuckets.delete(bucket);
  pendingLoads.delete(bucket);
  try {
    const file = usageFileForBucket(bucket);
    if (file.exists) file.delete();
  } catch {
    // ignore
  }
}
