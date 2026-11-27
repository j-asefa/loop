import { File as ExpoFile, Paths } from "expo-file-system";
import { draftWorkspaceBucket } from "./drafts-codec";
import {
  createEmptySnippetUsageMap,
  mergeSnippetUsageMaps,
  parseSnippetUsageStore,
  recordSnippetUseInStore,
  serializeSnippetUsageStore,
  type SnippetUsageMap,
} from "./snippet-usage-codec";

export {
  computeKeyboardInset,
  computeQuickSheetLayout,
  createEmptySnippetUsageMap,
  mergeSnippetUsageMaps,
  recordSnippetUseInStore,
  sortSnippetsByUsage,
  type SnippetUsageEntry,
  type SnippetUsageMap,
} from "./snippet-usage-codec";

type PendingUseOp = {
  content: string;
  serverUseCount?: number;
  now: number;
};

const memoryBuckets = new Map<string, SnippetUsageMap>();
const loadedBuckets = new Set<string>();
const pendingLoads = new Map<string, Promise<SnippetUsageMap>>();
const pendingOpsByBucket = new Map<string, PendingUseOp[]>();
const bucketEpoch = new Map<string, number>();

function usageFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.cache, `loop-snippet-usage-${bucket}.json`);
}

function writeBucketFile(bucket: string, map: SnippetUsageMap): void {
  try {
    usageFileForBucket(bucket).write(serializeSnippetUsageStore(map));
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
    const pending = pendingOpsByBucket.get(bucket);
    pendingOpsByBucket.delete(bucket);
    let merged = mergeSnippetUsageMaps(
      loaded,
      memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap(),
    );
    let dirty = false;
    if (pending?.length) {
      for (const op of pending) {
        merged = recordSnippetUseInStore(
          merged,
          op.content,
          op.serverUseCount,
          op.now,
        );
      }
      dirty = true;
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

export async function loadSnippetUsage(
  origin: string | null | undefined,
): Promise<SnippetUsageMap> {
  if (!origin) return createEmptySnippetUsageMap();
  return ensureBucketLoaded(draftWorkspaceBucket(origin));
}

export function recordSnippetUse(
  origin: string | null | undefined,
  content: string,
  serverUseCount?: number,
): SnippetUsageMap {
  if (!origin) return createEmptySnippetUsageMap();
  const bucket = draftWorkspaceBucket(origin);
  const now = Date.now();
  const current = memoryBuckets.get(bucket) ?? createEmptySnippetUsageMap();
  const next = recordSnippetUseInStore(current, content, serverUseCount, now);
  memoryBuckets.set(bucket, next);
  if (!loadedBuckets.has(bucket)) {
    const queue = pendingOpsByBucket.get(bucket) ?? [];
    queue.push({ content, serverUseCount, now });
    pendingOpsByBucket.set(bucket, queue);
    void ensureBucketLoaded(bucket);
    return next;
  }
  writeBucketFile(bucket, next);
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
  pendingOpsByBucket.delete(bucket);
  try {
    const file = usageFileForBucket(bucket);
    if (file.exists) file.delete();
  } catch {
    // ignore
  }
}
