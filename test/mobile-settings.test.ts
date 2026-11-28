import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopClient } from "../apps/mobile/src/api/client.js";
import type {
  ApiConnection,
  ApiMcpPreferences,
  ApiMemoryStatus,
  ApiPermissionMode,
  ApiSearchPreferences,
  ApiSearchStatus,
  PairedSession,
} from "../apps/mobile/src/api/types.js";
import {
  DEFAULT_DEVICE_PREFS,
  parseDevicePrefs,
  resolveThemeDark,
  serializeDevicePrefs,
} from "../apps/mobile/src/device-prefs-codec.js";
import { LAYERS } from "../apps/mobile/src/layers.js";
import {
  buildWebSettingsUrl,
  countMcpTools,
  formatCacheSummary,
  isHarnessConnection,
  summarizeConnections,
  summarizeMemoryStatus,
} from "../apps/mobile/src/settings-helpers.js";
import {
  McpPreferencesInput,
  PublicMcpPreferences,
} from "../src/shared/mcp-contract-schemas.js";
import {
  MemoryPolicyInput,
  PublicMemoryStatus,
} from "../src/shared/memory-contract-schemas.js";
import {
  PreferencesInput,
  PublicPreferences,
  PublicSearchStatus,
} from "../src/shared/library-contract-schemas.js";
import type { PermissionMode } from "../src/shared/permission-modes.js";

// Compile-time guard: mobile permission mode union must match the server's PermissionMode.
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _permissionModeMatches: AssertEqual<ApiPermissionMode, PermissionMode> =
  true;
void _permissionModeMatches;

const SESSION: PairedSession = {
  origin: "https://loop.example.test",
  cookie: "loop_session=test",
  csrf: "csrf-token-123",
  deviceName: "Test iPhone",
  pairedAt: 1_700_000_000_000,
};

function makeConn(overrides: Partial<ApiConnection> = {}): ApiConnection {
  return {
    id: "conn-1",
    provider: "anthropic",
    label: "Claude Code",
    status: "connected",
    models: "[]",
    metadata: JSON.stringify({
      authMode: "subscription",
      loopHarness: "claude",
    }),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile device preferences codec", () => {
  it("falls back to defaults on invalid or malformed JSON", () => {
    expect(parseDevicePrefs("")).toEqual(DEFAULT_DEVICE_PREFS);
    expect(parseDevicePrefs("not-json")).toEqual(DEFAULT_DEVICE_PREFS);
    expect(parseDevicePrefs("[]")).toEqual(DEFAULT_DEVICE_PREFS);
    expect(
      parseDevicePrefs(
        JSON.stringify({ themeMode: "sepia", hapticsEnabled: "yes" }),
      ),
    ).toEqual(DEFAULT_DEVICE_PREFS);
  });

  it("round-trips valid theme mode and haptics preference", () => {
    const raw = serializeDevicePrefs({
      themeMode: "system",
      hapticsEnabled: false,
    });
    expect(parseDevicePrefs(raw)).toEqual({
      themeMode: "system",
      hapticsEnabled: false,
    });
  });

  it("resolves system, light, and dark themes accurately", () => {
    expect(resolveThemeDark("light", "dark")).toBe(false);
    expect(resolveThemeDark("dark", "light")).toBe(true);
    expect(resolveThemeDark("system", "dark")).toBe(true);
    expect(resolveThemeDark("system", "light")).toBe(false);
    expect(resolveThemeDark("system", null)).toBe(false);
  });
});

describe("mobile settings helpers and stacking layers", () => {
  it("places Settings above the floating tab dock and below Pairing and Toasts", () => {
    expect(LAYERS.settings).toBeGreaterThan(LAYERS.tabDock);
    expect(LAYERS.settings).toBeLessThan(LAYERS.pairing);
    expect(LAYERS.settings).toBeLessThan(LAYERS.toast);
  });

  it("summarizes connections without probing", () => {
    expect(summarizeConnections([])).toEqual({
      total: 0,
      connected: 0,
      unhealthy: 0,
      tone: "muted",
      label: "",
    });
    expect(
      summarizeConnections([makeConn(), makeConn({ id: "conn-2" })]),
    ).toEqual({
      total: 2,
      connected: 2,
      unhealthy: 0,
      tone: "ready",
      label: "2 ready",
    });
    expect(
      summarizeConnections([
        makeConn(),
        makeConn({ id: "conn-2", status: "needs_auth" }),
      ]),
    ).toEqual({
      total: 2,
      connected: 1,
      unhealthy: 1,
      tone: "attention",
      label: "1 needs attention",
    });
    expect(
      summarizeConnections([
        makeConn({ id: "conn-1", status: "error" }),
        makeConn({ id: "conn-2", status: "disconnected" }),
      ]),
    ).toEqual({
      total: 2,
      connected: 0,
      unhealthy: 2,
      tone: "attention",
      label: "2 need attention",
    });
  });

  it("separates coding harnesses from direct API-key connections", () => {
    expect(isHarnessConnection(makeConn())).toBe(true);
    expect(
      isHarnessConnection(
        makeConn({ provider: "codex", metadata: JSON.stringify({}) }),
      ),
    ).toBe(true);
    expect(
      isHarnessConnection(
        makeConn({
          provider: "anthropic",
          metadata: JSON.stringify({ authMode: "api" }),
        }),
      ),
    ).toBe(false);
    expect(
      isHarnessConnection(
        makeConn({
          provider: "openai",
          metadata: JSON.stringify({}),
        }),
      ),
    ).toBe(false);
  });

  it("counts MCP tools and summarizes memory status safely", () => {
    expect(countMcpTools('[{"name":"a"},{"name":"b"}]')).toBe(2);
    expect(countMcpTools("not-json")).toBe(0);
    expect(countMcpTools(null)).toBe(0);

    const status: ApiMemoryStatus = {
      policies: [{ scope: "workspace", enabled: 0 }],
      sources: [
        {
          id: "src-1",
          title: "Pinned note",
          kind: "note",
          project_id: null,
          revision: 1,
          eligible: 1,
          tombstone: 0,
        },
        {
          id: "src-2",
          title: "Deleted note",
          kind: "note",
          project_id: null,
          revision: 1,
          eligible: 1,
          tombstone: 1,
        },
      ],
    };
    expect(summarizeMemoryStatus(status)).toEqual({
      workspaceEnabled: false,
      noteCount: 1,
      savedCount: 1,
    });
  });

  it("formats cache summaries and validates companion web URLs", () => {
    expect(formatCacheSummary(null)).toBe("No cached snapshot");
    expect(
      formatCacheSummary({
        exists: true,
        bytes: 4096,
        savedAt: 1_700_000_000_000,
        cardCount: 12,
      }),
    ).toBe("12 cards · 4 KB");
    expect(buildWebSettingsUrl("https://loop.example.test/foo")).toBe(
      "https://loop.example.test",
    );
    expect(buildWebSettingsUrl("http://192.168.1.5:3000")).toBe(
      "http://192.168.1.5:3000",
    );
    expect(buildWebSettingsUrl("javascript:alert(1)")).toBeNull();
    expect(buildWebSettingsUrl("not-a-url")).toBeNull();
  });
});

describe("LoopClient settings routes contract parity", () => {
  it("dispatches settings requests matching server route schemas", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      let payload: unknown = { ok: true };
      if (url.endsWith("/api/mcp/preferences")) {
        const prefs: ApiMcpPreferences & { resumed?: number } = {
          approvalMode: "ask",
          agentPermissionMode: "acceptEdits",
          ...(method === "PUT" ? { resumed: 0 } : {}),
        };
        PublicMcpPreferences.parse(prefs);
        if (method === "PUT") McpPreferencesInput.parse(body);
        payload = prefs;
      } else if (url.endsWith("/api/memory")) {
        const mem: ApiMemoryStatus = {
          policies: [{ scope: "workspace", enabled: 1 }],
          sources: [],
        };
        PublicMemoryStatus.parse(mem);
        payload = mem;
      } else if (url.endsWith("/api/memory/policy")) {
        MemoryPolicyInput.parse(body);
        payload = { ok: true };
      } else if (url.endsWith("/api/search/status")) {
        const status: ApiSearchStatus = {
          enabled: false,
          state: "disabled",
          total: 10,
          indexed: 0,
          pending: 0,
          detail: null,
        };
        PublicSearchStatus.parse(status);
        payload = status;
      } else if (url.endsWith("/api/preferences")) {
        if (method === "POST") {
          PreferencesInput.parse(body);
          payload = { ok: true };
        } else {
          const prefs: ApiSearchPreferences = { embedding_enabled: 0 };
          PublicPreferences.parse(prefs);
          payload = prefs;
        }
      } else if (url.endsWith("/api/connections/conn-1/refresh")) {
        payload = { models: [] };
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new LoopClient(SESSION);
    await client.refreshConnection("conn-1");
    await client.mcpPreferences();
    await client.updateMcpPreferences({ agentPermissionMode: "acceptEdits" });
    await client.memoryStatus();
    await client.updateMemoryPolicy("workspace", false);
    await client.searchStatus();
    await client.searchPreferences();
    await client.updateSearchPreferences({
      embeddingEnabled: false,
      connectionId: null,
    });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/connections/conn-1/refresh",
      "GET /api/mcp/preferences",
      "PUT /api/mcp/preferences",
      "GET /api/memory",
      "PUT /api/memory/policy",
      "GET /api/search/status",
      "GET /api/preferences",
      "POST /api/preferences",
    ]);
  });
});
