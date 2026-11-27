import type { ApiAgent, ApiFeedSummary, ApiFolder } from "./api/types";
import type { FeedTab, NativeResultCard } from "./fixtures";

export const OFFLINE_CACHE_VERSION = 1;
export const OFFLINE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CACHED_CARDS = 40;
export const MAX_CACHED_AGENTS = 60;
export const MAX_CACHED_FOLDERS = 60;
export const MAX_CACHED_CARD_BODY_CHARS = 8_000;

export type WorkspaceCacheSnapshot = {
  version: typeof OFFLINE_CACHE_VERSION;
  cachedAt: number;
  environmentName: string;
  cards: NativeResultCard[];
  agents: ApiAgent[];
  folders: ApiFolder[];
  summary: ApiFeedSummary | null;
};

const VALID_TABS = new Set<FeedTab>(["done", "working", "queued", "replies"]);

function clampString(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sanitizeCard(raw: unknown): NativeResultCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const id = clampString(c.id, 160).trim();
  const conversationId = clampString(c.conversationId, 160).trim();
  if (!id || !conversationId) return null;
  const tab: FeedTab =
    typeof c.tab === "string" && VALID_TABS.has(c.tab as FeedTab)
      ? (c.tab as FeedTab)
      : "done";
  const createdAt = optionalFiniteNumber(c.createdAt) ?? 0;

  // Strict allowlist — never serialize unexpected properties or auth metadata.
  const clean: NativeResultCard = {
    id,
    conversationId,
    tab,
    agentId: typeof c.agentId === "string" ? clampString(c.agentId, 160) : null,
    agentName: clampString(c.agentName, 80) || "agent",
    projectName: clampString(c.projectName, 120) || "Workspace",
    model: clampString(c.model, 120),
    prompt: clampString(c.prompt, 1_000),
    fallbackTitle: clampString(c.fallbackTitle, 240) || "Result",
    body: clampString(c.body, MAX_CACHED_CARD_BODY_CHARS),
    bodyTruncated: Boolean(
      c.bodyTruncated ||
      (typeof c.body === "string" &&
        c.body.length > MAX_CACHED_CARD_BODY_CHARS),
    ),
    createdAt,
    saved: Boolean(c.saved),
    unread: Boolean(c.unread),
    ...(typeof c.doneUnread === "boolean" ? { doneUnread: c.doneUnread } : {}),
    ...(typeof c.replyUnread === "boolean"
      ? { replyUnread: c.replyUnread }
      : {}),
    ...(typeof c.statusLabel === "string"
      ? { statusLabel: clampString(c.statusLabel, 40) }
      : {}),
    ...(typeof c.messageId === "string" && c.messageId
      ? { messageId: clampString(c.messageId, 160) }
      : {}),
    ...(typeof c.doneCardKey === "string" && c.doneCardKey
      ? { doneCardKey: clampString(c.doneCardKey, 200) }
      : {}),
    ...(typeof c.replyCardKey === "string" && c.replyCardKey
      ? { replyCardKey: clampString(c.replyCardKey, 200) }
      : {}),
    ...(optionalFiniteNumber(c.unreadVersion) !== undefined
      ? { unreadVersion: optionalFiniteNumber(c.unreadVersion) }
      : {}),
    ...(typeof c.runId === "string" && c.runId
      ? { runId: clampString(c.runId, 160) }
      : {}),
    ...(typeof c.runState === "string" && c.runState
      ? { runState: clampString(c.runState, 40) }
      : {}),
  };
  return clean;
}

function sanitizeAgent(raw: unknown): ApiAgent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const id = clampString(a.id, 160).trim();
  const name = clampString(a.name, 100).trim();
  if (!id || !name) return null;
  // Omit agent instructions & connection secrets from offline disk cache.
  return {
    id,
    name,
    provider: clampString(a.provider, 60),
    connection_id:
      typeof a.connection_id === "string"
        ? clampString(a.connection_id, 160)
        : null,
    model: clampString(a.model, 120),
    ...(typeof a.effort === "string" || a.effort === null
      ? {
          effort:
            typeof a.effort === "string" ? clampString(a.effort, 40) : null,
        }
      : {}),
    instructions: "",
    ...(typeof a.folder_id === "string" || a.folder_id === null
      ? {
          folder_id:
            typeof a.folder_id === "string"
              ? clampString(a.folder_id, 160)
              : null,
        }
      : {}),
    ...(optionalFiniteNumber(a.retired_at) !== undefined ||
    a.retired_at === null
      ? {
          retired_at:
            a.retired_at === null
              ? null
              : (optionalFiniteNumber(a.retired_at) ?? null),
        }
      : {}),
  };
}

function sanitizeFolder(raw: unknown): ApiFolder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const id = clampString(f.id, 160).trim();
  const name = clampString(f.name, 120).trim();
  if (!id || !name) return null;
  // Omit host filesystem `path` from offline mobile cache.
  return {
    id,
    name,
    parent_id:
      typeof f.parent_id === "string" ? clampString(f.parent_id, 160) : null,
    kind: f.kind === "project" ? "project" : "folder",
    ...(typeof f.is_workspace === "boolean" ||
    typeof f.is_workspace === "number"
      ? { is_workspace: Boolean(f.is_workspace) }
      : {}),
  };
}

function sanitizeSummary(raw: unknown): ApiFeedSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  return {
    needs: num(s.needs),
    working: num(s.working),
    queued: num(s.queued),
    later_due: num(s.later_due),
    ...(optionalFiniteNumber(s.replies_unread) !== undefined
      ? { replies_unread: num(s.replies_unread) }
      : {}),
    ...(optionalFiniteNumber(s.done_unread) !== undefined
      ? { done_unread: num(s.done_unread) }
      : {}),
    ...(optionalFiniteNumber(s.social_unread) !== undefined
      ? { social_unread: num(s.social_unread) }
      : {}),
    ...(optionalFiniteNumber(s.scheduled_failed) !== undefined
      ? { scheduled_failed: num(s.scheduled_failed) }
      : {}),
    ...(optionalFiniteNumber(s.scheduled_pending) !== undefined
      ? { scheduled_pending: num(s.scheduled_pending) }
      : {}),
  };
}

export function sanitizeWorkspaceCacheSnapshot(
  input: {
    environmentName?: string;
    cards: NativeResultCard[];
    agents: ApiAgent[];
    folders: ApiFolder[];
    summary: ApiFeedSummary | null;
  },
  now = Date.now(),
): WorkspaceCacheSnapshot {
  const cards: NativeResultCard[] = [];
  for (const raw of input.cards) {
    if (cards.length >= MAX_CACHED_CARDS) break;
    const clean = sanitizeCard(raw);
    if (clean) cards.push(clean);
  }
  const agents: ApiAgent[] = [];
  for (const raw of input.agents) {
    if (agents.length >= MAX_CACHED_AGENTS) break;
    const clean = sanitizeAgent(raw);
    if (clean) agents.push(clean);
  }
  const folders: ApiFolder[] = [];
  for (const raw of input.folders) {
    if (folders.length >= MAX_CACHED_FOLDERS) break;
    const clean = sanitizeFolder(raw);
    if (clean) folders.push(clean);
  }
  return {
    version: OFFLINE_CACHE_VERSION,
    cachedAt: Number.isFinite(now) ? now : Date.now(),
    environmentName: clampString(input.environmentName, 120),
    cards,
    agents,
    folders,
    summary: sanitizeSummary(input.summary),
  };
}

export function serializeWorkspaceCache(
  input: {
    environmentName?: string;
    cards: NativeResultCard[];
    agents: ApiAgent[];
    folders: ApiFolder[];
    summary: ApiFeedSummary | null;
  },
  now = Date.now(),
): string {
  return JSON.stringify(sanitizeWorkspaceCacheSnapshot(input, now));
}

export function parseWorkspaceCache(
  raw: string,
  now = Date.now(),
): WorkspaceCacheSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== OFFLINE_CACHE_VERSION) return null;
    if (
      typeof obj.cachedAt !== "number" ||
      !Number.isFinite(obj.cachedAt) ||
      obj.cachedAt <= 0
    ) {
      return null;
    }
    if (now - obj.cachedAt > OFFLINE_CACHE_TTL_MS) return null;
    if (obj.cachedAt > now + 60_000) return null;

    const rawCards = Array.isArray(obj.cards) ? obj.cards : [];
    const rawAgents = Array.isArray(obj.agents) ? obj.agents : [];
    const rawFolders = Array.isArray(obj.folders) ? obj.folders : [];

    const clean = sanitizeWorkspaceCacheSnapshot(
      {
        environmentName: clampString(obj.environmentName, 120),
        cards: rawCards as NativeResultCard[],
        agents: rawAgents as ApiAgent[],
        folders: rawFolders as ApiFolder[],
        summary: obj.summary as ApiFeedSummary | null,
      },
      obj.cachedAt,
    );
    return clean;
  } catch {
    return null;
  }
}
