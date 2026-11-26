export type DraftEntry = {
  text: string;
  updatedAt: number;
};

export type DraftMap = Record<string, DraftEntry>;

export const MAX_DRAFT_CHARS = 32_000;
export const MAX_DRAFTS_PER_WORKSPACE = 80;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createEmptyDraftMap(): DraftMap {
  return Object.create(null) as DraftMap;
}

/**
 * Derive an isolated, filesystem-safe 64-bit bucket name from the workspace origin so drafts
 * from one workspace never leak into another workspace or Demo mode.
 */
export function draftWorkspaceBucket(origin?: string | null): string {
  const normalized = (origin ?? "").trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return "demo";
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `ws_${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export function draftScopeForCarousel(conversationId: string): string {
  return `carousel:${conversationId}`;
}

export function draftScopeForThread(conversationId: string): string {
  return `thread:${conversationId}`;
}

export function draftScopeForCompose(
  agentId?: string | null,
  folderId?: string | null,
): string {
  if (agentId) return `compose:agent:${agentId}`;
  return `compose:new:${folderId || "root"}`;
}

export function pruneDraftStore(input: DraftMap, now = Date.now()): DraftMap {
  const cutoff = now - DRAFT_TTL_MS;
  const valid: Array<[string, DraftEntry]> = [];
  for (const key of Object.keys(input)) {
    const entry = input[key];
    if (
      !entry ||
      typeof entry.text !== "string" ||
      !entry.text.trim() ||
      typeof entry.updatedAt !== "number" ||
      !Number.isFinite(entry.updatedAt) ||
      entry.updatedAt < cutoff
    ) {
      continue;
    }
    valid.push([
      key,
      {
        text:
          entry.text.length > MAX_DRAFT_CHARS
            ? entry.text.slice(0, MAX_DRAFT_CHARS)
            : entry.text,
        updatedAt: entry.updatedAt,
      },
    ]);
  }
  valid.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const out = createEmptyDraftMap();
  for (const [key, entry] of valid.slice(0, MAX_DRAFTS_PER_WORKSPACE)) {
    out[key] = entry;
  }
  return out;
}

export function parseDraftStore(raw: string, now = Date.now()): DraftMap {
  if (!raw) return createEmptyDraftMap();
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      drafts?: Record<string, unknown>;
    };
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) {
      return createEmptyDraftMap();
    }
    const source = parsed.drafts;
    if (!source || typeof source !== "object") return createEmptyDraftMap();
    const loaded = createEmptyDraftMap();
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const item = source[key] as { text?: unknown; updatedAt?: unknown };
      if (
        item &&
        typeof item === "object" &&
        typeof item.text === "string" &&
        typeof item.updatedAt === "number"
      ) {
        loaded[key] = { text: item.text, updatedAt: item.updatedAt };
      }
    }
    return pruneDraftStore(loaded, now);
  } catch {
    return createEmptyDraftMap();
  }
}

export function serializeDraftStore(map: DraftMap, now = Date.now()): string {
  const pruned = pruneDraftStore(map, now);
  return JSON.stringify({ v: 1, drafts: pruned });
}

export function setDraftInStore(
  map: DraftMap,
  scope: string,
  text: string,
  now = Date.now(),
): DraftMap {
  const next = Object.assign(createEmptyDraftMap(), map);
  if (!text.trim()) {
    delete next[scope];
    return pruneDraftStore(next, now);
  }
  next[scope] = {
    text: text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text,
    updatedAt: now,
  };
  return pruneDraftStore(next, now);
}

export function deleteDraftFromStore(map: DraftMap, scope: string): DraftMap {
  if (!Object.prototype.hasOwnProperty.call(map, scope)) return map;
  const next = Object.assign(createEmptyDraftMap(), map);
  delete next[scope];
  return next;
}

export function readDraftFromStore(
  map: DraftMap,
  scope: string,
  now = Date.now(),
): string {
  if (!Object.prototype.hasOwnProperty.call(map, scope)) return "";
  const entry = map[scope];
  if (!entry || entry.updatedAt < now - DRAFT_TTL_MS) return "";
  return entry.text;
}
