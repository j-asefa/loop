import { File as ExpoFile, Paths } from "expo-file-system";
import {
  createEmptyDraftMap,
  deleteDraftFromStore,
  draftWorkspaceBucket,
  parseDraftStore,
  readDraftFromStore,
  serializeDraftStore,
  setDraftInStore,
  type DraftMap,
} from "./drafts-codec";

export {
  draftScopeForCarousel,
  draftScopeForCompose,
  draftScopeForThread,
} from "./drafts-codec";

const WRITE_DEBOUNCE_MS = 350;

const memoryBuckets = new Map<string, DraftMap>();
const loadedBuckets = new Set<string>();
const pendingLoads = new Map<string, Promise<DraftMap>>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const bucketEpoch = new Map<string, number>();

function draftFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.cache, `loop-drafts-${bucket}.json`);
}

async function ensureBucketLoaded(bucket: string): Promise<DraftMap> {
  if (loadedBuckets.has(bucket)) {
    return memoryBuckets.get(bucket) ?? createEmptyDraftMap();
  }
  const existingLoad = pendingLoads.get(bucket);
  if (existingLoad) return existingLoad;

  const epochAtStart = bucketEpoch.get(bucket) ?? 0;
  const loadPromise = (async () => {
    let loaded = createEmptyDraftMap();
    try {
      const file = draftFileForBucket(bucket);
      if (file.exists) {
        const raw = await file.text();
        loaded = parseDraftStore(raw);
      }
    } catch {
      loaded = createEmptyDraftMap();
    }
    // If the bucket was cleared or written to while loading, merge safely without
    // resurrecting cleared drafts or overwriting newer in-memory edits.
    if ((bucketEpoch.get(bucket) ?? 0) !== epochAtStart) {
      return memoryBuckets.get(bucket) ?? createEmptyDraftMap();
    }
    const inMemory = memoryBuckets.get(bucket);
    const merged = inMemory
      ? Object.assign(createEmptyDraftMap(), loaded, inMemory)
      : loaded;
    memoryBuckets.set(bucket, merged);
    loadedBuckets.add(bucket);
    return merged;
  })().finally(() => {
    if (pendingLoads.get(bucket) === loadPromise) {
      pendingLoads.delete(bucket);
    }
  });

  pendingLoads.set(bucket, loadPromise);
  return loadPromise;
}

function flushBucketNow(bucket: string): void {
  const timer = flushTimers.get(bucket);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(bucket);
  }
  try {
    const map = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
    const file = draftFileForBucket(bucket);
    if (Object.keys(map).length === 0) {
      if (file.exists) file.delete();
      return;
    }
    file.write(serializeDraftStore(map));
  } catch {
    // Cache persistence is best-effort; never disrupt typing or sending.
  }
}

function scheduleBucketFlush(bucket: string): void {
  const existing = flushTimers.get(bucket);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    flushTimers.delete(bucket);
    flushBucketNow(bucket);
  }, WRITE_DEBOUNCE_MS);
  flushTimers.set(bucket, timer);
}

export async function loadDraft(
  origin: string | null | undefined,
  scope: string,
): Promise<string> {
  const bucket = draftWorkspaceBucket(origin);
  const map = await ensureBucketLoaded(bucket);
  return readDraftFromStore(map, scope);
}

export function saveDraft(
  origin: string | null | undefined,
  scope: string,
  text: string,
): void {
  const bucket = draftWorkspaceBucket(origin);
  const current = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
  const next = setDraftInStore(current, scope, text);
  memoryBuckets.set(bucket, next);
  loadedBuckets.add(bucket);
  scheduleBucketFlush(bucket);
}

export function clearDraft(
  origin: string | null | undefined,
  scope: string,
): void {
  const bucket = draftWorkspaceBucket(origin);
  const current = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
  const next = deleteDraftFromStore(current, scope);
  memoryBuckets.set(bucket, next);
  loadedBuckets.add(bucket);
  flushBucketNow(bucket);
}

/** Purge all cached drafts for a workspace on sign-out or session expiry. */
export function clearWorkspaceDrafts(origin: string | null | undefined): void {
  const bucket = draftWorkspaceBucket(origin);
  bucketEpoch.set(bucket, (bucketEpoch.get(bucket) ?? 0) + 1);
  const timer = flushTimers.get(bucket);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(bucket);
  }
  memoryBuckets.set(bucket, createEmptyDraftMap());
  loadedBuckets.add(bucket);
  try {
    const file = draftFileForBucket(bucket);
    if (file.exists) file.delete();
  } catch {
    // ignore
  }
}
