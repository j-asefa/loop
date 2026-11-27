import { File as ExpoFile, Paths } from "expo-file-system";
import {
  createEmptyDraftMap,
  deleteDraftFromStore,
  draftWorkspaceBucket,
  parseDraftStore,
  readDraftEntryFromStore,
  serializeDraftStore,
  settlePendingAgentCreateInStore,
  setDraftInStore,
  type DraftEntry,
  type DraftMap,
  type DraftPendingMeta,
} from "./drafts-codec";

export {
  draftScopeForCarousel,
  draftScopeForCompose,
  draftScopeForShare,
  draftScopeForThread,
  type DraftEntry,
  type DraftPendingMeta,
  type PendingScheduleDraft,
  type PendingAgentCreate,
  type PendingShareDraft,
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
  return new ExpoFile(Paths.document, `loop-drafts-${bucket}.json`);
}

function legacyDraftFileForBucket(bucket: string): ExpoFile {
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
  const legacy = legacyDraftFileForBucket(bucket);
  if (Object.keys(map).length === 0) {
    if (legacy.exists) legacy.delete();
    if (file.exists) file.delete();
    return;
  }
  file.writeSync(serializeDraftStore(map));
  try {
    if (legacy.exists) legacy.delete();
  } catch {
    // The durable file takes precedence on the next read.
  }
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
    let readLegacy = false;
    try {
      const file = draftFileForBucket(bucket);
      const legacy = legacyDraftFileForBucket(bucket);
      if (file.exists) {
        loaded = parseDraftStore(await file.text());
      } else if (legacy.exists) {
        loaded = parseDraftStore(await legacy.text());
        readLegacy = true;
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
        if (
          merged[scope]?.pendingSchedule ||
          merged[scope]?.pendingShare ||
          merged[scope]?.pendingAgentCreate
        ) {
          continue;
        }
        merged = deleteDraftFromStore(merged, scope);
        dirty = true;
      }
      for (const [scope, op] of ops.saves) {
        // Never allow an ordinary typing save queued during initial disk load
        // to overwrite a persisted pendingSchedule or pendingShare lock on disk.
        if (merged[scope]?.pendingSchedule && !op.pending?.schedule) continue;
        if (merged[scope]?.pendingShare && !op.pending?.share) continue;
        if (merged[scope]?.pendingAgentCreate && !op.pending?.agentCreate)
          continue;
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
    if (dirty || readLegacy) {
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
  const pendingCreate = current[scope]?.pendingAgentCreate;
  if (
    pendingCreate &&
    pendingCreate.idempotencyKey !== pending?.agentCreate?.idempotencyKey
  )
    return;
  const next = setDraftInStore(current, scope, text, Date.now(), pending);
  memoryBuckets.set(bucket, next);
  if (
    pending?.key ||
    pending?.schedule ||
    pending?.share ||
    pending?.agentCreate
  ) {
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
  const epoch = bucketEpoch.get(bucket);
  await ensureBucketLoaded(bucket);
  if (bucketEpoch.get(bucket) !== epoch) {
    throw new Error("Workspace changed while saving the draft.");
  }
  const current = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
  const existingAgentCreate = current[scope]?.pendingAgentCreate;
  if (
    existingAgentCreate &&
    pending?.agentCreate &&
    existingAgentCreate.idempotencyKey !== pending.agentCreate.idempotencyKey
  ) {
    throw new Error("A pending agent creation already exists for this draft.");
  }
  const existingSchedule = current[scope]?.pendingSchedule;
  if (
    existingSchedule &&
    pending?.schedule &&
    existingSchedule.key !== pending.schedule.key
  ) {
    throw new Error(
      "A pending scheduled send already exists for this draft — check Profile → Scheduled before scheduling again.",
    );
  }
  const existingShare = current[scope]?.pendingShare;
  if (
    existingShare &&
    pending?.share &&
    existingShare.key !== pending.share.key
  ) {
    throw new Error(
      "A pending share send already exists for this item — check your Feed before sending again.",
    );
  }
  const next = setDraftInStore(current, scope, text, Date.now(), pending);
  if (pending?.agentCreate && !next[scope]?.pendingAgentCreate) {
    throw new Error("Could not save the settings for this agent creation.");
  }
  const timer = flushTimers.get(bucket);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(bucket);
  }
  try {
    writeBucketFile(bucket, next);
  } catch {
    throw new Error(
      "Could not persist send recovery state locally. Please try again.",
    );
  }
  memoryBuckets.set(bucket, next);
}

export function settlePendingAgentCreate(
  origin: string,
  scope: string,
  idempotencyKey: string,
  text?: string,
): "settled" | "stale" | "write-failed" {
  const bucket = draftWorkspaceBucket(origin);
  const current = memoryBuckets.get(bucket);
  if (!current) return "stale";
  const next = settlePendingAgentCreateInStore(
    current,
    scope,
    idempotencyKey,
    text,
  );
  if (next === current) return "stale";
  try {
    writeBucketFile(bucket, next);
  } catch {
    return "write-failed";
  }
  memoryBuckets.set(bucket, next);
  return "settled";
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
  for (const makeFile of [draftFileForBucket, legacyDraftFileForBucket]) {
    try {
      const file = makeFile(bucket);
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup on sign-out.
    }
  }
}
