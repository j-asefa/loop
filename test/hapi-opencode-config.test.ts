import { afterEach, expect, it, vi } from "vitest";
import {
  validateManagedOpencodeConfig,
  managedOpencodeConfig,
} from "../native/loopManaged";
const config = () => ({
  enabled_providers: ["openai"],
  provider: {
    openai: { options: { baseURL: "loop-subscription-only://openai/v1" } },
  },
  model: "openai/gpt-5.4",
  small_model: "openai/gpt-5.4",
  agent: { build: { model: "openai/gpt-5.4" } },
});
afterEach(() => vi.unstubAllEnvs());
it("accepts the restricted effective configuration", () => {
  expect(() => validateManagedOpencodeConfig(config())).not.toThrow();
});
it.each([
  { enabled_providers: ["openai", "anthropic"] },
  { plugin: ["file:///injected.mjs"] },
  {
    provider: { openai: { options: { baseURL: "https://api.openai.com/v1" } } },
  },
  {
    provider: {
      openai: {
        options: {
          baseURL: "loop-subscription-only://openai/v1",
          apiKey: "secret",
        },
      },
    },
  },
  { provider: { openai: { npm: "custom", options: {} } } },
  { provider: { openai: { models: { custom: {} }, options: {} } } },
  { small_model: "anthropic/claude" },
  { agent: { hidden: { model: "other/model" } } },
  { command: { summarize: { model: "other/model" } } },
  { mode: { plan: { model: "other/model" } } },
])("refuses overrides without disclosing their values", (override) => {
  expect(() =>
    validateManagedOpencodeConfig({ ...config(), ...override }),
  ).toThrow("OpenCode effective subscription configuration rejected");
});
it.each([null, [], "secret", { enabled_providers: "openai" }])(
  "fails closed for malformed native responses",
  (value) => {
    expect(() => validateManagedOpencodeConfig(value)).toThrow();
  },
);
it("leaves standalone HAPI configuration untouched", async () => {
  vi.stubEnv("LOOP_MANAGED", "0");
  await expect(
    managedOpencodeConfig("https://unused.invalid", "/unused"),
  ).resolves.toBeUndefined();
});
