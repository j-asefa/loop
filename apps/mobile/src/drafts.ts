import { File as ExpoFile, Paths } from "expo-file-system";
import {
  UnreadableDraftStore,
  createEmptyDraftMap,
  deleteDraftFromStore,
  draftWorkspaceBucket,
  parseDraftStore,
  readDraftEntryFromStore,
  serializeDraftStore,
  settlePendingAgentCreateInStore,
  settlePendingReplyInStore,
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

function stagedDraftFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.document, `loop-drafts-${bucket}.staged.json`);
}

function previousDraftFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.document, `loop-drafts-${bucket}.previous.json`);
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
  const staged = stagedDraftFileForBucket(bucket);
  const previous = previousDraftFileForBucket(bucket);
  const legacy = legacyDraftFileForBucket(bucket);

  // Write the full snapshot before replacing the committed file. Preserve the
  // old snapshot across the rename so an interrupted commit remains readable.
  staged.writeSync(serializeDraftStore(map));
  if (file.exists) {
    if (previous.exists) previous.delete();
    file.moveSync(previous);
  }
  staged.moveSync(draftFileForBucket(bucket));

  // Even an empty committed snapshot masks older drafts after settlement.
  for (const obsolete of [previous, legacy]) {
    try {
      if (obsolete.exists) obsolete.delete();
    } catch {
      // The committed file takes precedence on the next read.
    }
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
    let recovered = false;
    const candidates = [
      draftFileForBucket(bucket),
      previousDraftFileForBucket(bucket),
      legacyDraftFileForBucket(bucket),
    ];
    for (const [index, file] of candidates.entries()) {
      if (!file.exists) continue;
      // I/O failures leave the bucket unloaded. Malformed bytes are kept
      // separately so the next readable snapshot can restore the workspace.
      const raw = await file.text();
      if ((bucketEpoch.get(bucket) ?? 0) !== epochAtStart) break;
      try {
        loaded = parseDraftStore(raw);
        recovered ||= index > 0;
        break;
      } catch (error) {
        if (!(error instanceof UnreadableDraftStore)) throw error;
        const suffix = `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
        file.moveSync(
          new ExpoFile(
            Paths.document,
            `loop-drafts-${bucket}.unreadable-${suffix}.json`,
          ),
        );
        recovered = true;
      }
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
          merged[scope]?.pendingKey ||
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
        // to overwrite a persisted request lock on disk.
        if (
          merged[scope]?.pendingKey &&
          merged[scope]?.pendingKey !== op.pending?.key
        )
          continue;
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
    if (dirty || recovered) {
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
    void ensureBucketLoaded(bucket).catch(() => {});
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
  if (
    current[scope]?.pendingKey &&
    pending?.key &&
    current[scope].pendingKey !== pending.key
  ) {
    throw new Error("A pending reply already exists for this draft.");
  }
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
  if (pending?.key && next[scope]?.pendingKey !== pending.key) {
    throw new Error("Could not save recovery state for this reply.");
  }
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

export function settlePendingReplyDraft(
  origin: string,
  scope: string,
  key: string,
  text?: string,
): "settled" | "stale" | "write-failed" {
  const bucket = draftWorkspaceBucket(origin);
  const current = memoryBuckets.get(bucket);
  if (!current) return "stale";
  const next = settlePendingReplyInStore(current, scope, key, text);
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
    void ensureBucketLoaded(bucket).catch(() => {});
    return;
  }
  const current = memoryBuckets.get(bucket) ?? createEmptyDraftMap();
  const next = deleteDraftFromStore(current, scope);
  memoryBuckets.set(bucket, next);
  flushBucketNow(bucket);
}

/** Purge the workspace's drafts on explicit sign-out. */
export function clearWorkspaceDrafts(origin: string | null | undefined): void {
  const bucket = draftWorkspaceBucket(origin);
  for (const makeFile of [
    draftFileForBucket,
    stagedDraftFileForBucket,
    previousDraftFileForBucket,
    legacyDraftFileForBucket,
  ]) {
    try {
      const file = makeFile(bucket);
      if (file.exists) file.delete();
    } catch {
      // Best-effort removal of files belonging to this session.
    }
  }
  try {
    for (const file of Paths.document.list()) {
      if (
        file instanceof ExpoFile &&
        file.name.startsWith(`loop-drafts-${bucket}.unreadable-`)
      ) {
        file.delete();
      }
    }
  } catch {
    // Draft cleanup can proceed even when an archived copy is inaccessible.
  }
  bucketEpoch.set(bucket, (bucketEpoch.get(bucket) ?? 0) + 1);
  pendingOpsByBucket.delete(bucket);
  const timer = flushTimers.get(bucket);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(bucket);
  }
  memoryBuckets.set(bucket, createEmptyDraftMap());
  loadedBuckets.add(bucket);
}
