import { formatFileBytes } from "./api/files";
import type { ApiConnection, ApiMemoryStatus } from "./api/types";

export type SettingsBadgeTone = "ready" | "attention" | "muted";

export type ConnectionSummary = {
  total: number;
  connected: number;
  unhealthy: number;
  tone: SettingsBadgeTone;
  label: string;
};

/**
 * Summarizes already-loaded connections for the Settings home badge and
 * Profile gear dot without triggering any background connection probes.
 */
export function summarizeConnections(
  connections: ApiConnection[],
): ConnectionSummary {
  const total = connections.length;
  const connected = connections.filter((c) => c.status === "connected").length;
  const unhealthy = total - connected;
  if (total === 0) {
    return { total: 0, connected: 0, unhealthy: 0, tone: "muted", label: "" };
  }
  if (unhealthy > 0) {
    return {
      total,
      connected,
      unhealthy,
      tone: "attention",
      label: `${unhealthy} need${unhealthy === 1 ? "s" : ""} attention`,
    };
  }
  return {
    total,
    connected,
    unhealthy: 0,
    tone: "ready",
    label: `${connected} ready`,
  };
}

/**
 * Distinguishes coding-harness connections (Claude Code, Codex, Antigravity,
 * etc.) from Loop's direct API-key runtime connections.
 */
export function isHarnessConnection(connection: ApiConnection): boolean {
  let meta: { authMode?: string; loopHarness?: string } | null = null;
  try {
    meta = JSON.parse(connection.metadata || "null") as {
      authMode?: string;
      loopHarness?: string;
    } | null;
  } catch {
    meta = null;
  }
  if (meta?.loopHarness) return true;
  if (connection.provider === "anthropic") {
    return meta?.authMode === "subscription";
  }
  if (connection.provider === "openai") {
    return meta?.authMode === "subscription";
  }
  return true;
}

export function countMcpTools(toolsJson: string | null | undefined): number {
  if (!toolsJson) return 0;
  try {
    const parsed = JSON.parse(toolsJson) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function summarizeMemoryStatus(status: ApiMemoryStatus | null): {
  workspaceEnabled: boolean;
  noteCount: number;
  savedCount: number;
} {
  if (!status) {
    return { workspaceEnabled: true, noteCount: 0, savedCount: 0 };
  }
  const workspaceEnabled =
    status.policies.find((p) => p.scope === "workspace")?.enabled !== 0;
  let noteCount = 0;
  let savedCount = 0;
  for (const s of status.sources) {
    if (s.tombstone) continue;
    if (s.kind === "note") noteCount += 1;
    if (s.eligible) savedCount += 1;
  }
  return { workspaceEnabled, noteCount, savedCount };
}

export type OfflineCacheInfo = {
  exists: boolean;
  bytes: number;
  savedAt: number | null;
  cardCount: number;
};

export function formatCacheSummary(info: OfflineCacheInfo | null): string {
  if (!info || !info.exists) return "No cached snapshot";
  const parts: string[] = [];
  if (info.cardCount > 0) {
    parts.push(`${info.cardCount} ${info.cardCount === 1 ? "card" : "cards"}`);
  }
  const size = formatFileBytes(info.bytes);
  if (size) parts.push(size);
  return parts.length > 0 ? parts.join(" · ") : "Cached snapshot";
}

/**
 * Builds a validated http(s) URL to the paired companion's web UI so the
 * "More in web app" shortcut never opens unexpected schemes.
 */
export function buildWebSettingsUrl(
  origin: string | null | undefined,
): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}
