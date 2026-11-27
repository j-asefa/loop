import type { AgentModelSelection } from "./models";

export type PendingAgentCreate = AgentModelSelection & {
  idempotencyKey: string;
  name: string;
  text: string;
  folderId: string | null;
  attachmentIds: string[];
};

export type PendingScheduleDraft = {
  key: string;
  sendAt: number;
  input?: string;
  agentId?: string;
  folderId?: string | null;
  attachmentIds?: string[];
  replyToMessageId?: string;
};

export type PendingShareDraft = {
  key: string;
  agentId?: string | null;
  folderId?: string | null;
  attachmentIds?: string[];
};

export type DraftPendingMeta = {
  key?: string;
  queue?: boolean;
  replyToMessageId?: string;
  replyAttachmentIds?: string[];
  schedule?: PendingScheduleDraft;
  share?: PendingShareDraft;
  agentCreate?: PendingAgentCreate;
};

export type DraftEntry = {
  text: string;
  updatedAt: number;
  /** Durable idempotency key persisted when a send times out with uncertain outcome. */
  pendingKey?: string;
  /** Original queue delivery flag paired with `pendingKey` so retries never mutate semantics. */
  pendingQueue?: boolean;
  pendingReplyToMessageId?: string;
  pendingReplyAttachmentIds?: string[];
  /** Durable schedule identity + payload metadata persisted before dispatch / across uncertain timeouts. */
  pendingSchedule?: PendingScheduleDraft;
  /** Durable share identity + routing/upload metadata persisted before dispatch / across uncertain timeouts. */
  pendingShare?: PendingShareDraft;
  pendingAgentCreate?: PendingAgentCreate;
};

function readPendingAgentCreate(raw: unknown): PendingAgentCreate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const {
    idempotencyKey,
    name,
    connectionId,
    model,
    effort,
    text,
    folderId,
    attachmentIds,
  } = item;
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 8 ||
    typeof name !== "string" ||
    !name ||
    typeof connectionId !== "string" ||
    !connectionId ||
    typeof model !== "string" ||
    !model ||
    (effort !== null && typeof effort !== "string") ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MAX_DRAFT_CHARS ||
    (folderId !== null && typeof folderId !== "string") ||
    !Array.isArray(attachmentIds) ||
    attachmentIds.length > 8 ||
    !attachmentIds.every(
      (id): id is string => typeof id === "string" && id.length > 0,
    )
  )
    return undefined;
  return {
    idempotencyKey,
    name,
    connectionId,
    model,
    effort,
    text,
    folderId,
    attachmentIds,
  };
}

function sanitizePendingShare(raw: unknown): PendingShareDraft | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as {
    key?: unknown;
    agentId?: unknown;
    folderId?: unknown;
    attachmentIds?: unknown;
  };
  if (typeof item.key !== "string" || item.key.length < 10) return undefined;
  const attachmentIds = Array.isArray(item.attachmentIds)
    ? item.attachmentIds
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .slice(0, 8)
    : undefined;
  return {
    key: item.key,
    ...(typeof item.agentId === "string" || item.agentId === null
      ? { agentId: item.agentId }
      : {}),
    ...(typeof item.folderId === "string" || item.folderId === null
      ? { folderId: item.folderId }
      : {}),
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
  };
}

function sanitizePendingSchedule(
  raw: unknown,
): PendingScheduleDraft | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as {
    key?: unknown;
    sendAt?: unknown;
    input?: unknown;
    agentId?: unknown;
    folderId?: unknown;
    attachmentIds?: unknown;
    replyToMessageId?: unknown;
  };
  if (
    typeof item.key !== "string" ||
    item.key.length < 8 ||
    typeof item.sendAt !== "number" ||
    !Number.isInteger(item.sendAt) ||
    item.sendAt <= 0
  ) {
    return undefined;
  }
  const attachmentIds = Array.isArray(item.attachmentIds)
    ? item.attachmentIds
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, 8)
    : undefined;
  const input =
    typeof item.input === "string" && item.input.trim().length > 0
      ? item.input.length > MAX_DRAFT_CHARS
        ? item.input.slice(0, MAX_DRAFT_CHARS)
        : item.input
      : undefined;
  const folderId =
    item.folderId === null
      ? null
      : typeof item.folderId === "string" && item.folderId
        ? item.folderId
        : undefined;
  return {
    key: item.key,
    sendAt: item.sendAt,
    ...(input ? { input } : {}),
    ...(typeof item.agentId === "string" && item.agentId
      ? { agentId: item.agentId }
      : {}),
    ...(folderId !== undefined ? { folderId } : {}),
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(typeof item.replyToMessageId === "string" && item.replyToMessageId
      ? { replyToMessageId: item.replyToMessageId }
      : {}),
  };
}

function readReplyAttachmentIds(raw: unknown): string[] | undefined {
  return Array.isArray(raw)
    ? raw
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, 8)
    : undefined;
}

export type DraftMap = Record<string, DraftEntry>;

export const MAX_DRAFT_CHARS = 32_000;
export const MAX_DRAFTS_PER_WORKSPACE = 80;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEDULE_GRACE_MS = 24 * 60 * 60 * 1000;

function isDraftEntryExpired(entry: DraftEntry, now: number): boolean {
  // Keep pending creation and share sends available until resolved after reconnecting.
  if (entry.pendingKey || entry.pendingShare || entry.pendingAgentCreate)
    return false;
  if (entry.pendingSchedule) {
    const scheduleExpiry = Math.max(
      entry.updatedAt + DRAFT_TTL_MS,
      entry.pendingSchedule.sendAt + SCHEDULE_GRACE_MS,
    );
    return now > scheduleExpiry;
  }
  return entry.updatedAt < now - DRAFT_TTL_MS;
}

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

export function draftScopeForShare(fingerprint: string): string {
  return `share:${fingerprint}`;
}

export function draftScopeForCompose(
  agentId?: string | null,
  folderId?: string | null,
): string {
  if (agentId) return `compose:agent:${agentId}`;
  return `compose:new:${folderId || "root"}`;
}

export function pruneDraftStore(input: DraftMap, now = Date.now()): DraftMap {
  const valid: Array<[string, DraftEntry]> = [];
  for (const key of Object.keys(input)) {
    const entry = input[key];
    if (
      !entry ||
      typeof entry.text !== "string" ||
      !entry.text.trim() ||
      typeof entry.updatedAt !== "number" ||
      !Number.isFinite(entry.updatedAt)
    ) {
      continue;
    }
    const pendingSchedule = sanitizePendingSchedule(entry.pendingSchedule);
    const pendingShare = sanitizePendingShare(entry.pendingShare);
    const pendingAgentCreate = readPendingAgentCreate(entry.pendingAgentCreate);
    const replyAttachmentIds = readReplyAttachmentIds(
      entry.pendingReplyAttachmentIds,
    );
    const normalized: DraftEntry = {
      text:
        entry.text.length > MAX_DRAFT_CHARS
          ? entry.text.slice(0, MAX_DRAFT_CHARS)
          : entry.text,
      updatedAt: entry.updatedAt,
      ...(typeof entry.pendingKey === "string" && entry.pendingKey.length >= 8
        ? { pendingKey: entry.pendingKey }
        : {}),
      ...(typeof entry.pendingQueue === "boolean"
        ? { pendingQueue: entry.pendingQueue }
        : {}),
      ...(typeof entry.pendingReplyToMessageId === "string" &&
      entry.pendingReplyToMessageId
        ? { pendingReplyToMessageId: entry.pendingReplyToMessageId }
        : {}),
      ...(replyAttachmentIds?.length
        ? { pendingReplyAttachmentIds: replyAttachmentIds }
        : {}),
      ...(pendingSchedule ? { pendingSchedule } : {}),
      ...(pendingShare ? { pendingShare } : {}),
      ...(pendingAgentCreate ? { pendingAgentCreate } : {}),
    };
    if (isDraftEntryExpired(normalized, now)) {
      continue;
    }
    valid.push([key, normalized]);
  }
  valid.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  // Pending sends take priority so ordinary drafts cannot evict their request details.
  const hasPendingSend = ([, entry]: [string, DraftEntry]) =>
    Boolean(
      entry.pendingKey ||
      entry.pendingSchedule ||
      entry.pendingShare ||
      entry.pendingAgentCreate,
    );
  const locked = valid.filter(hasPendingSend);
  const unlocked = valid.filter((entry) => !hasPendingSend(entry));
  const remainingSlots = Math.max(0, MAX_DRAFTS_PER_WORKSPACE - locked.length);
  const out = createEmptyDraftMap();
  for (const [key, entry] of [
    ...locked,
    ...unlocked.slice(0, remainingSlots),
  ]) {
    out[key] = entry;
  }
  return out;
}

export class UnreadableDraftStore extends Error {
  constructor() {
    super("Could not read the existing local drafts.");
  }
}

export function parseDraftStore(raw: string, now = Date.now()): DraftMap {
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      drafts?: Record<string, unknown>;
    };
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) {
      throw new Error("Unexpected draft format.");
    }
    const source = parsed.drafts;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Missing draft entries.");
    }
    const loaded = createEmptyDraftMap();
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const item = source[key] as {
        text?: unknown;
        updatedAt?: unknown;
        pendingKey?: unknown;
        pendingQueue?: unknown;
        pendingReplyToMessageId?: unknown;
        pendingReplyAttachmentIds?: unknown;
        pendingSchedule?: unknown;
        pendingShare?: unknown;
        pendingAgentCreate?: unknown;
      };
      if (
        item &&
        typeof item === "object" &&
        typeof item.text === "string" &&
        typeof item.updatedAt === "number"
      ) {
        const pendingSchedule = sanitizePendingSchedule(item.pendingSchedule);
        const pendingShare = sanitizePendingShare(item.pendingShare);
        const pendingAgentCreate = readPendingAgentCreate(
          item.pendingAgentCreate,
        );
        const replyAttachmentIds = readReplyAttachmentIds(
          item.pendingReplyAttachmentIds,
        );
        loaded[key] = {
          text: item.text,
          updatedAt: item.updatedAt,
          ...(typeof item.pendingKey === "string" && item.pendingKey.length >= 8
            ? { pendingKey: item.pendingKey }
            : {}),
          ...(typeof item.pendingQueue === "boolean"
            ? { pendingQueue: item.pendingQueue }
            : {}),
          ...(typeof item.pendingReplyToMessageId === "string"
            ? { pendingReplyToMessageId: item.pendingReplyToMessageId }
            : {}),
          ...(replyAttachmentIds?.length
            ? { pendingReplyAttachmentIds: replyAttachmentIds }
            : {}),
          ...(pendingSchedule ? { pendingSchedule } : {}),
          ...(pendingShare ? { pendingShare } : {}),
          ...(pendingAgentCreate ? { pendingAgentCreate } : {}),
        };
      }
    }
    return pruneDraftStore(loaded, now);
  } catch {
    throw new UnreadableDraftStore();
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
  pending?: DraftPendingMeta,
): DraftMap {
  const next = Object.assign(createEmptyDraftMap(), map);
  if (!text.trim()) {
    delete next[scope];
    return pruneDraftStore(next, now);
  }
  const pendingSchedule = sanitizePendingSchedule(pending?.schedule);
  const pendingShare = sanitizePendingShare(pending?.share);
  const pendingAgentCreate = readPendingAgentCreate(pending?.agentCreate);
  next[scope] = {
    text: text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text,
    updatedAt: now,
    ...(pending?.key ? { pendingKey: pending.key } : {}),
    ...(pending?.queue !== undefined ? { pendingQueue: pending.queue } : {}),
    ...(pending?.replyToMessageId
      ? { pendingReplyToMessageId: pending.replyToMessageId }
      : {}),
    ...(pending?.replyAttachmentIds?.length
      ? { pendingReplyAttachmentIds: pending.replyAttachmentIds }
      : {}),
    ...(pendingSchedule ? { pendingSchedule } : {}),
    ...(pendingShare ? { pendingShare } : {}),
    ...(pendingAgentCreate ? { pendingAgentCreate } : {}),
  };
  return pruneDraftStore(next, now);
}

export function deleteDraftFromStore(map: DraftMap, scope: string): DraftMap {
  if (!Object.prototype.hasOwnProperty.call(map, scope)) return map;
  const next = Object.assign(createEmptyDraftMap(), map);
  delete next[scope];
  return next;
}

// A late completion can only settle the creation whose key it dispatched.
export function settlePendingAgentCreateInStore(
  map: DraftMap,
  scope: string,
  idempotencyKey: string,
  text?: string,
  now = Date.now(),
): DraftMap {
  if (map[scope]?.pendingAgentCreate?.idempotencyKey !== idempotencyKey)
    return map;
  return text === undefined
    ? deleteDraftFromStore(map, scope)
    : setDraftInStore(map, scope, text, now);
}

export function settlePendingReplyInStore(
  map: DraftMap,
  scope: string,
  key: string,
  text?: string,
  now = Date.now(),
): DraftMap {
  if (map[scope]?.pendingKey !== key) return map;
  return text === undefined
    ? deleteDraftFromStore(map, scope)
    : setDraftInStore(map, scope, text, now);
}

export function readDraftEntryFromStore(
  map: DraftMap,
  scope: string,
  now = Date.now(),
): DraftEntry | null {
  if (!Object.prototype.hasOwnProperty.call(map, scope)) return null;
  const entry = map[scope];
  if (!entry || isDraftEntryExpired(entry, now)) return null;
  return entry;
}

export function readDraftFromStore(
  map: DraftMap,
  scope: string,
  now = Date.now(),
): string {
  return readDraftEntryFromStore(map, scope, now)?.text ?? "";
}
