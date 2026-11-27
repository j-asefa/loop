import { describe, expect, it, vi } from "vitest";
import {
  agentModelLabel,
  connectedHarnesses,
  defaultModelFor,
  harnessLabel,
  modelCatalog,
  runModelLabel,
} from "../apps/mobile/src/models.js";
import { LoopClient } from "../apps/mobile/src/api/client.js";
import {
  createEmptyDraftMap,
  DRAFT_TTL_MS,
  parseDraftStore,
  serializeDraftStore,
  settlePendingAgentCreateInStore,
  setDraftInStore,
} from "../apps/mobile/src/drafts-codec.js";
import type { ApiConnection } from "../apps/mobile/src/api/types.js";

function connection(
  id: string,
  provider: string,
  models: unknown[],
  extra: Partial<ApiConnection> = {},
): ApiConnection {
  return {
    id,
    provider,
    label: id,
    status: "connected",
    models: JSON.stringify(models),
    metadata: "{}",
    ...extra,
  };
}

// Catalog shapes recorded by the harness adapters.
const connections = [
  connection(
    "claude",
    "anthropic",
    [
      {
        id: "native-default",
        name: "Use native default",
        resolvedModel: "claude-opus-5-5",
      },
      { id: "fable", name: "Fable 5.2", resolvedModel: "claude-fable-5-2" },
    ],
    { metadata: JSON.stringify({ loopHarness: "claude" }) },
  ),
  connection("codex", "codex", [
    {
      id: "native-default",
      name: "Use native default",
      resolvedModel: "gpt-6.2-sol",
    },
    { id: "gpt-6.2-sol", name: "GPT-6.2-Sol" },
  ]),
  connection("agy", "antigravity", [
    { id: "native-default", name: "Use native default" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
  ]),
  connection("pi", "pi", [
    {
      id: "native-default",
      name: "Use native default",
      resolvedModel: "anthropic/claude-opus-4-8",
    },
  ]),
  connection("grok", "grok", [{ id: "native-default", name: "x" }], {
    status: "disconnected",
  }),
];

describe("mobile model labels", () => {
  it("reads each agent's model from its own connection catalog", () => {
    const label = (connection_id: string, model: string) =>
      agentModelLabel({ connection_id, model }, connections);
    expect(label("claude", "native-default")).toBe("Claude Opus 5.5");
    expect(label("claude", "fable")).toBe("Claude Fable 5.2");
    expect(label("codex", "native-default")).toBe("GPT-6.2-Sol");
    expect(label("agy", "gemini-4-hydrogen")).toBe("Gemini 4 Hydrogen");
    expect(label("pi", "native-default")).toBe("Claude Opus 4.8");
    expect(label("agy", "native-default")).toBe("Antigravity default");
    // A model missing from the catalog keeps its saved id.
    expect(label("codex", "gpt-7")).toBe("gpt-7");
    // A missing connection never borrows another connection's default.
    expect(label("gone", "native-default")).toBe("Default model");
  });

  it("labels run models and hides unresolved defaults", () => {
    expect(runModelLabel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(runModelLabel("native-default")).toBe("");
    expect(runModelLabel(null)).toBe("");
  });

  it("offers connected harnesses with their default model", () => {
    const harnesses = connectedHarnesses(connections);
    expect(harnesses.map((c) => c.id)).not.toContain("grok");
    expect(harnesses.map(harnessLabel)).toContain("Claude Code");
    expect(defaultModelFor(harnesses[0])).toBe("native-default");
    expect(defaultModelFor(connection("empty", "opencode", []))).toBe("");
  });
});

describe("mobile model defaults", () => {
  it("offers only effort values the selected model reports", () => {
    const configured = connection("codex", "codex", [
      {
        id: "model-a",
        name: "Model A",
        effortLevels: [
          { value: "low" },
          { value: "xhigh" },
          { value: "low" },
          { value: "Mal Formed" },
          null,
        ],
        defaultEffort: "low",
      },
      { id: "model-b", name: "Model B" },
    ]);
    const [a, b] = modelCatalog(configured);
    expect(a.effortLevels).toEqual(["low", "xhigh"]);
    expect(a.defaultEffort).toBe("low");
    expect(b.effortLevels).toBeUndefined();
  });

  it("keeps an uncertain creation's exact settings and payload through draft reload and expiry", () => {
    const pending = {
      idempotencyKey: "creation-key",
      connectionId: "codex",
      name: "test-agent",
      model: "model-a",
      effort: "xhigh",
      text: "Attached example.txt",
      folderId: "project-a",
      attachmentIds: ["attachment-a"],
    };
    const now = 123_000;
    const scope = "compose:new:project-a";
    const map = setDraftInStore(
      createEmptyDraftMap(),
      scope,
      pending.text,
      now,
      {
        agentCreate: pending,
      },
    );
    const restored = parseDraftStore(
      serializeDraftStore(map, now),
      now + DRAFT_TTL_MS + 1,
    );
    expect(restored[scope].pendingAgentCreate).toEqual(pending);
    const staleKey = "older-creation-key";
    expect(settlePendingAgentCreateInStore(restored, scope, staleKey)).toBe(
      restored,
    );
    expect(
      settlePendingAgentCreateInStore(restored, scope, staleKey, "Old text"),
    ).toBe(restored);
    expect(
      settlePendingAgentCreateInStore(restored, scope, pending.idempotencyKey)[
        scope
      ],
    ).toBeUndefined();
    expect(
      settlePendingAgentCreateInStore(
        restored,
        scope,
        pending.idempotencyKey,
        "Try again",
        now,
      )[scope],
    ).toEqual({ text: "Try again", updatedAt: now });
  });

  it("sends the configured model and effort through the create and update client calls", async () => {
    const origin = "https://loop.example.com";
    const mockFetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url) =>
        ({
          ok: true,
          status: 200,
          redirected: false,
          url: String(url),
          text: async () => JSON.stringify({ id: "agent-1" }),
        }) as Response,
    );
    try {
      const client = new LoopClient({
        origin,
        cookie: "__Host-loop=token",
        csrf: "csrf-1",
        deviceName: "Fixture",
        pairedAt: 1,
      });
      await client.createAgent({
        name: "test-agent",
        connectionId: "codex",
        model: "model-a",
        effort: "xhigh",
        initialPrompt: "Start here",
        idempotencyKey: "creation-key",
      });
      await client.updateAgentModel("agent-1", {
        connectionId: "codex",
        model: "model-b",
        effort: null,
      });
      const [create, update] = mockFetch.mock.calls;
      expect(create[0]).toBe(origin + "/api/agents");
      expect(create[1]?.method).toBe("POST");
      expect(JSON.parse(String(create[1]?.body))).toEqual({
        name: "test-agent",
        connectionId: "codex",
        model: "model-a",
        effort: "xhigh",
        initialPrompt: "Start here",
        attachmentIds: [],
        idempotencyKey: "creation-key",
      });
      expect(update[0]).toBe(origin + "/api/agents/agent-1");
      expect(update[1]?.method).toBe("PATCH");
      expect(JSON.parse(String(update[1]?.body))).toEqual({
        connectionId: "codex",
        model: "model-b",
        effort: null,
      });
    } finally {
      mockFetch.mockRestore();
    }
  });
});
