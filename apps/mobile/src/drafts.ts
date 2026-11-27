import { File as ExpoFile, Paths } from "expo-file-system";
import {
  createEmptyDraftMap,
  deleteDraftFromStore,
  draftWorkspaceBucket,
  parseDraftStore,
  readDraftEntryFromStore,
  serializeDraftStore,
  setDraftInStore,
  type DraftEntry,
  type DraftMap,
  type DraftPendingMeta,
} from "./drafts-codec";

export {
  draftScopeForCarousel,
  draftScopeForCompose,
  draftScopeForThread,
  type DraftEntry,
  type DraftPendingMeta,
  type PendingScheduleDraft,
} from "./drafts-codec";

const WRITE_DEBOUNCE_MS = 350;

type PendingSaveOp = {
  text: string;
  pending?: DraftPendingMeta;
};

type PendingOps = {
  saves: Map<string, PendingSaveOp>;
  deletes: Set<string>;
};

const memoryBuckets = new Map<string, DraftMap>();
const loadedBuckets = new Set<string>();
const pendingLoads = new Map<string, Promise<DraftMap>>();
const pendingOpsByBucket = new Map<string, PendingOps>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const bucketEpoch = new Map<string, number>();

function draftFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.cache, `loop-drafts-${bucket}.json`);
}

function getOrCreatePendingOps(bucket: string): PendingOps {
  let ops = pendingOpsByBucket.get(bucket);
  if (!ops) {
    ops = { saves: new Map(), deletes: new Set() };
    pendingOpsByBucket.set(bucket, ops);
  }
  return ops;
}

function writeBucketFile(bucket: string, map: DraftMap): void {
  const file = draftFileForBucket(bucket);
  if (Object.keys(map).length === 0) {
    if (file.exists) file.delete();
    return;
  }
  file.write(serializeDraftStore(map));
}

function flushBucketNow(bucket: string): void {
  const timer = flushTimers.get(bucket);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(bucket);
  }
  if (!loadedBuckets.has(bucket)) return;
  try {
    const map = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
    writeBucketFile(bucket, map);
  } catch {
    // Best-effort flush for ordinary draft typing.
  }
}

function scheduleBucketFlush(bucket: string): void {
  if (!loadedBuckets.has(bucket)) return;
  const existing = flushTimers.get(bucket);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    flushTimers.delete(bucket);
    flushBucketNow(bucket);
  }, WRITE_DEBOUNCE_MS);
  flushTimers.set(bucket, timer);
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
    // If `clearWorkspaceDrafts` bumped the epoch while reading disk, discard the stale read.
    if ((bucketEpoch.get(bucket) ?? 0) !== epochAtStart) {
      return memoryBuckets.get(bucket) ?? createEmptyDraftMap();
    }
    // Replay any saves/deletes queued while the initial disk read was in flight so we
    // never overwrite unrelated scopes on disk or resurrect a just-sent draft.
    const ops = pendingOpsByBucket.get(bucket);
    pendingOpsByBucket.delete(bucket);
    let merged = loaded;
    let dirty = false;
    if (ops) {
      for (const scope of ops.deletes) {
        if (merged[scope]?.pendingSchedule) continue;
        merged = deleteDraftFromStore(merged, scope);
        dirty = true;
      }
      for (const [scope, op] of ops.saves) {
        // Never allow an ordinary typing save queued during initial disk load
        // to overwrite a persisted pendingSchedule lock on disk.
        if (merged[scope]?.pendingSchedule && !op.pending?.schedule) continue;
        merged = setDraftInStore(
          merged,
          scope,
          op.text,
          Date.now(),
          op.pending,
        );
        dirty = true;
      }
    }
    memoryBuckets.set(bucket, merged);
    loadedBuckets.add(bucket);
    if (dirty) {
      flushBucketNow(bucket);
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

export async function loadDraftEntry(
  origin: string | null | undefined,
  scope: string,
): Promise<DraftEntry | null> {
  const bucket = draftWorkspaceBucket(origin);
  const map = await ensureBucketLoaded(bucket);
  return readDraftEntryFromStore(map, scope);
}

export async function loadDraft(
  origin: string | null | undefined,
  scope: string,
): Promise<string> {
  return (await loadDraftEntry(origin, scope))?.text ?? "";
}

export function saveDraft(
  origin: string | null | undefined,
  scope: string,
  text: string,
  pending?: DraftPendingMeta,
): void {
  const bucket = draftWorkspaceBucket(origin);
  if (!loadedBuckets.has(bucket)) {
    const ops = getOrCreatePendingOps(bucket);
    if (text.trim()) {
      ops.deletes.delete(scope);
      ops.saves.set(scope, { text, pending });
    } else {
      ops.saves.delete(scope);
      ops.deletes.add(scope);
    }
    void ensureBucketLoaded(bucket);
    return;
  }
  const current = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
  const next = setDraftInStore(current, scope, text, Date.now(), pending);
  memoryBuckets.set(bucket, next);
  if (pending?.key || pending?.schedule) {
    flushBucketNow(bucket);
  } else {
    scheduleBucketFlush(bucket);
  }
}

export async function saveDraftAndFlush(
  origin: string | null | undefined,
  scope: string,
  text: string,
  pending?: DraftPendingMeta,
): Promise<void> {
  const bucket = draftWorkspaceBucket(origin);
  await ensureBucketLoaded(bucket);
  const current = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
  const next = setDraftInStore(current, scope, text, Date.now(), pending);
  const timer = flushTimers.get(bucket);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(bucket);
  }
  try {
    writeBucketFile(bucket, next);
  } catch {
    throw new Error(
      "Could not persist schedule recovery state locally. Please try again.",
    );
  }
  memoryBuckets.set(bucket, next);
}

export function clearDraft(
  origin: string | null | undefined,
  scope: string,
): void {
  const bucket = draftWorkspaceBucket(origin);
  if (!loadedBuckets.has(bucket)) {
    const ops = getOrCreatePendingOps(bucket);
    ops.saves.delete(scope);
    ops.deletes.add(scope);
    void ensureBucketLoaded(bucket);
    return;
  }
  const current = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
  const next = deleteDraftFromStore(current, scope);
  memoryBuckets.set(bucket, next);
  flushBucketNow(bucket);
}

/** Purge all cached drafts for a workspace on sign-out or session expiry. */
export function clearWorkspaceDrafts(origin: string | null | undefined): void {
  const bucket = draftWorkspaceBucket(origin);
  bucketEpoch.set(bucket, (bucketEpoch.get(bucket) ?? 0) + 1);
  pendingOpsByBucket.delete(bucket);
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
