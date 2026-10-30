import { afterEach, expect, it, vi } from "vitest";
const model = () => ({
  providerID: "openai",
  api: { id: "gpt-5.4", npm: "@ai-sdk/openai" },
  headers: {},
});
const options = () => ({
  baseURL: "loop55-subscription-only://openai/v1",
  apiKey: "opencode-oauth-dummy-key",
  fetch: () => {},
  headerTimeout: 300000,
});
const provider = () => ({ id: "openai" });
const flags = () => ({
  pure: true,
  disableDefaultPlugins: false,
  experimentalNativeLlm: false,
  experimentalWebSockets: false,
});
async function load(enabled = true) {
  vi.resetModules();
  vi.stubEnv("LOOP55_OPENCODE_SUBSCRIPTION_ONLY", enabled ? "1" : "0");
  return import("../native/opencode-execution-guard");
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("preserves native OAuth routing and captures enforcement before environment mutation", async () => {
  const guard = await load();
  expect(guard.executionGuardStatus()).toEqual({
    revision: "loop55-subscription-v1",
    active: true,
  });
  guard.guardRuntime(flags());
  guard.guardSDK(model(), provider(), options());
  guard.guardOAuth(
    { type: "oauth" },
    "loop55-subscription-only://openai/v1/responses",
  );
  vi.stubEnv("LOOP55_OPENCODE_SUBSCRIPTION_ONLY", "0");
  expect(() =>
    guard.guardOAuth(
      { type: "api", key: "never report" },
      "https://api.openai.com/v1/responses",
    ),
  ).toThrow("execution policy rejected");
});
it.each([
  ["pure", false],
  ["disableDefaultPlugins", true],
  ["experimentalNativeLlm", true],
  ["experimentalWebSockets", true],
])("rejects alternate runtime path %s", async (name, value) => {
  const guard = await load();
  expect(() =>
    guard.guardRuntime({ ...flags(), [String(name)]: value }),
  ).toThrow("execution policy rejected");
});
it.each([
  (m: any, p: any, o: any) => {
    m.providerID = "anthropic";
  },
  (m: any, p: any, o: any) => {
    p.id = "custom";
  },
  (m: any, p: any, o: any) => {
    p.key = "never report";
  },
  (m: any, p: any, o: any) => {
    m.api.npm = "custom-sdk";
  },
  (m: any, p: any, o: any) => {
    m.api.id = "../other";
  },
  (m: any, p: any, o: any) => {
    m.headers.authorization = "never report";
  },
  (m: any, p: any, o: any) => {
    o.baseURL = "https://api.openai.com/v1";
  },
  (m: any, p: any, o: any) => {
    o.apiKey = "never report";
  },
  (m: any, p: any, o: any) => {
    delete o.fetch;
  },
  (m: any, p: any, o: any) => {
    o.headers = { authorization: "never report" };
  },
  (m: any, p: any, o: any) => {
    o.custom = true;
  },
])(
  "rejects newly resolved unsafe SDKs after a previously valid construction",
  async (mutate) => {
    const guard = await load();
    guard.guardSDK(model(), provider(), options());
    const m = model(),
      p = provider(),
      o = options();
    mutate(m, p, o);
    expect(() => guard.guardSDK(m, p, o)).toThrow("execution policy rejected");
  },
);
it.each([
  undefined,
  null,
  { type: "api", key: "never report" },
  { type: "wellknown" },
])("refuses auth loss before fallback", async (auth) => {
  const guard = await load();
  expect(() =>
    guard.guardOAuth(auth, "loop55-subscription-only://openai/v1/responses"),
  ).toThrow("execution policy rejected");
});
it.each([
  "https://api.openai.com/v1/responses",
  "loop55-subscription-only://openai/v1/responses?redirect=x",
  "loop55-subscription-only://other/v1/responses",
  "invalid",
])("rejects an unexpected request route", async (url) => {
  const guard = await load();
  expect(() => guard.guardOAuth({ type: "oauth" }, url)).toThrow(
    "execution policy rejected",
  );
});
it("leaves unmanaged native execution unchanged", async () => {
  const guard = await load(false);
  expect(guard.executionGuardStatus().active).toBe(false);
  guard.guardRuntime({ ...flags(), pure: false });
  guard.guardSDK(null, null, null);
  guard.guardOAuth(undefined, "anything");
});
