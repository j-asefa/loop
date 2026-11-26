import { describe, expect, it } from "vitest";
import {
  agentModelLabel,
  connectedHarnesses,
  defaultModelFor,
  harnessLabel,
  runModelLabel,
} from "../apps/mobile/src/models.js";
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
