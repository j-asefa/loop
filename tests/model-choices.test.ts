import { expect, it } from "vitest";
import { agentModelName, modelDisplayName } from "../src/client/modelChoices";
import type { Connection } from "../src/shared/types";

it("shows harness-resolved versions without guessing the version of an alias", () => {
  expect(
    modelDisplayName({
      id: "opus",
      name: "Opus",
      resolvedModel: "claude-opus-5-5[1m]",
    }),
  ).toBe("Claude Opus 5.5 (1M)");
  expect(
    modelDisplayName({
      id: "sonnet",
      name: "Sonnet",
      resolvedModel: "claude-sonnet-5",
    }),
  ).toBe("Claude Sonnet 5");
  expect(
    modelDisplayName({
      id: "haiku",
      name: "Haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
    }),
  ).toBe("Claude Haiku 4.5");
  expect(modelDisplayName({ id: "claude-opus-4-8", name: "Opus" })).toBe(
    "Claude Opus 4.8",
  );
  expect(modelDisplayName({ id: "opus", name: "Opus" })).toBe("Opus");
  expect(
    modelDisplayName({
      id: "default",
      name: "Default",
      resolvedModel: "future-model-exact-version",
    }),
  ).toBe("future-model-exact-version");
  expect(modelDisplayName({ id: "gpt-6-astra", name: "GPT-6 Astra" })).toBe(
    "GPT-6 Astra",
  );
});

it("resolves the model using the agent's own connection", () => {
  const connections = [
    {
      id: "first",
      models: JSON.stringify([
        { id: "opus", name: "Opus", resolvedModel: "claude-opus-4-8" },
      ]),
    },
    {
      id: "second",
      models: JSON.stringify([
        { id: "opus", name: "Opus", resolvedModel: "claude-opus-5-5" },
      ]),
    },
  ] as Connection[];
  expect(
    agentModelName({ connection_id: "first", model: "opus" }, connections),
  ).toBe("Claude Opus 4.8");
  expect(
    agentModelName({ connection_id: "second", model: "opus" }, connections),
  ).toBe("Claude Opus 5.5");
  expect(
    agentModelName({ connection_id: "missing", model: "opus" }, connections),
  ).toBe("opus");
});
