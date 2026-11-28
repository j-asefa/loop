import { File as ExpoFile, Paths } from "expo-file-system";
import type { ApiAgent, ApiFeedSummary, ApiFolder } from "./api/types";
import { draftWorkspaceBucket } from "./drafts-codec";
import type { NativeResultCard } from "./fixtures";
import {
  parseWorkspaceCache,
  serializeWorkspaceCache,
  type WorkspaceCacheSnapshot,
} from "./offline-cache-codec";

export { type WorkspaceCacheSnapshot } from "./offline-cache-codec";

const cacheEpoch = new Map<string, number>();

function cacheFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.cache, `loop-cache-${bucket}.json`);
}

export async function loadWorkspaceCache(
  origin: string | null | undefined,
): Promise<WorkspaceCacheSnapshot | null> {
  if (!origin) return null;
  const bucket = draftWorkspaceBucket(origin);
  const epochAtStart = cacheEpoch.get(bucket) ?? 0;
  try {
    const file = cacheFileForBucket(bucket);
    if (!file.exists) return null;
    const raw = await file.text();
    if ((cacheEpoch.get(bucket) ?? 0) !== epochAtStart) {
      return null;
    }
    return parseWorkspaceCache(raw);
  } catch {
    return null;
  }
}

export function saveWorkspaceCache(
  origin: string | null | undefined,
  snapshot: {
    environmentName?: string;
    cards: NativeResultCard[];
    agents: ApiAgent[];
    folders: ApiFolder[];
    summary: ApiFeedSummary | null;
  },
): void {
  if (!origin) return;
  const bucket = draftWorkspaceBucket(origin);
  cacheEpoch.set(bucket, (cacheEpoch.get(bucket) ?? 0) + 1);
  try {
    const file = cacheFileForBucket(bucket);
    file.writeSync(serializeWorkspaceCache(snapshot));
  } catch {
    // Best-effort offline cache write; never disrupt live workspace sync.
  }
}

/** Inspects the current workspace's cached snapshot size and card count. */
export async function inspectWorkspaceCache(
  origin: string | null | undefined,
): Promise<{
  exists: boolean;
  bytes: number;
  savedAt: number | null;
  cardCount: number;
}> {
  if (!origin) {
    return { exists: false, bytes: 0, savedAt: null, cardCount: 0 };
  }
  const bucket = draftWorkspaceBucket(origin);
  try {
    const file = cacheFileForBucket(bucket);
    if (!file.exists) {
      return { exists: false, bytes: 0, savedAt: null, cardCount: 0 };
    }
    const raw = await file.text();
    const parsed = parseWorkspaceCache(raw);
    const bytes =
      typeof file.size === "number" && Number.isFinite(file.size)
        ? file.size
        : raw.length;
    return {
      exists: true,
      bytes,
      savedAt: parsed?.cachedAt ?? null,
      cardCount: parsed?.cards.length ?? 0,
    };
  } catch {
    return { exists: false, bytes: 0, savedAt: null, cardCount: 0 };
  }
}

/** Purge cached workspace snapshot on sign-out or session expiry. */
export function clearWorkspaceCache(origin: string | null | undefined): void {
  if (!origin) return;
  const bucket = draftWorkspaceBucket(origin);
  cacheEpoch.set(bucket, (cacheEpoch.get(bucket) ?? 0) + 1);
  try {
    const file = cacheFileForBucket(bucket);
    if (file.exists) file.delete();
  } catch {
    // Best-effort cleanup for this session.
  }
}
