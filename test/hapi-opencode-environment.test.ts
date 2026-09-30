import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  managedOpencodeEnvironment,
  inspectOpencodeNativeAuth,
} from "../native/loopManaged";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(
  auth: unknown = {
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: 1,
  },
) {
  const home = mkdtempSync(join(tmpdir(), "loop-opencode-env-"));
  dirs.push(home);
  const data = join(home, "native-data");
  mkdirSync(join(data, "opencode"), { recursive: true });
  writeFileSync(
    join(data, "opencode", "auth.json"),
    JSON.stringify({ openai: auth }),
  );
  const binding = join(home, "launch.json");
  writeFileSync(
    binding,
    JSON.stringify({
      flavor: "opencode",
      generation: 7,
      billing: { requiredAuth: "chatgpt", allowApiFallback: false },
    }),
  );
  vi.stubEnv("LOOP_MANAGED", "1");
  vi.stubEnv("LOOP_LAUNCH_FILE", binding);
  vi.stubEnv("LOOP_ENVIRONMENT_GENERATION", "7");
  return { HOME: home, XDG_DATA_HOME: data, PATH: "/fixture/bin" };
}
it("preserves native credential home but excludes host billing, plugin, transport and loader overrides", () => {
  const native = fixture();
  const source = {
    ...native,
    OPENAI_API_KEY: "host-key",
    FUTURE_PROVIDER_TOKEN: "host-token",
    NODE_OPTIONS: "--import injected",
    BUN_OPTIONS: "injected",
    LD_PRELOAD: "injected",
    OPENCODE_AUTH_CONTENT: "host-auth",
    OPENCODE_CONFIG_CONTENT: "host-config",
    OPENCODE_CONFIG_DIR: "/injected",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_EXPERIMENTAL: "1",
    HTTPS_PROXY: "http://injected",
    OPENCODE_SERVER_PASSWORD: "host-password",
  };
  const env = managedOpencodeEnvironment(source);
  expect(env).toMatchObject(native);
  for (const name of Object.keys(source).filter(
    (name) => !(name in native) && name !== "OPENCODE_CONFIG_CONTENT",
  ))
    expect(env[name]).toBeUndefined();
  expect(env.OPENCODE_PURE).toBe("1");
  expect(env.OPENCODE_EXPERIMENTAL_NATIVE_LLM).toBe("0");
  expect(env.OPENCODE_EXPERIMENTAL_WEBSOCKETS).toBe("0");
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
    enabled_providers: ["openai"],
    provider: {
      openai: { options: { baseURL: "loop-subscription-only://openai/v1" } },
    },
  });
  expect(source.OPENCODE_AUTH_CONTENT).toBe("host-auth");
  expect(JSON.stringify(env)).not.toContain("fixture-refresh");
});
it.each([
  undefined,
  { type: "api", key: "fixture-key" },
  { type: "oauth", refresh: "fixture" },
])("refuses missing or non-OAuth credentials", (auth) => {
  const env = fixture(auth === undefined ? null : auth);
  expect(() => managedOpencodeEnvironment(env)).toThrow("native OpenAI OAuth");
});
it("rejects stale binding and relative native homes", () => {
  const env = fixture();
  expect(() =>
    managedOpencodeEnvironment({ ...env, XDG_DATA_HOME: "relative" }),
  ).toThrow("absolute");
  vi.stubEnv("LOOP_ENVIRONMENT_GENERATION", "8");
  expect(() => managedOpencodeEnvironment(env)).toThrow("Fenced");
});
it("does not restrict standalone HAPI", () => {
  vi.stubEnv("LOOP_MANAGED", "0");
  const env = { OPENCODE_CONFIG_CONTENT: "existing" };
  expect(managedOpencodeEnvironment(env)).toBe(env);
});

it("runner status and launch read the same native store on every check", () => {
  const env = fixture();
  // An expired access token with refresh credentials still represents native
  // sign-in; only the native runtime can refresh it and prove live validity.
  const status = inspectOpencodeNativeAuth({
    ...env,
    OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"override"}}',
  });
  expect(status).toMatchObject({
    authenticated: true,
    authMethod: "chatgpt",
    managed: true,
  });
  expect(status.models).toEqual([]);
  expect(JSON.stringify(status)).not.toMatch(
    /fixture|native-data|refresh|access/,
  );
  managedOpencodeEnvironment(env);
  writeFileSync(
    join(env.XDG_DATA_HOME, "opencode", "auth.json"),
    JSON.stringify({ openai: { type: "api", key: "never expose" } }),
  );
  expect(inspectOpencodeNativeAuth(env).authenticated).toBe(false);
  expect(() => managedOpencodeEnvironment(env)).toThrow("native OpenAI OAuth");
  writeFileSync(
    join(env.XDG_DATA_HOME, "opencode", "auth.json"),
    "invalid-json-secret",
  );
  expect(inspectOpencodeNativeAuth(env).authenticated).toBe(false);
});
it("runner status uses the default native data home and rejects relative homes", () => {
  const env = fixture();
  expect(inspectOpencodeNativeAuth({ HOME: env.HOME }).authenticated).toBe(
    false,
  );
  const directory = join(env.HOME, ".local", "share", "opencode");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "synthetic",
        refresh: "synthetic",
        expires: 1,
      },
    }),
  );
  expect(inspectOpencodeNativeAuth({ HOME: env.HOME }).authenticated).toBe(
    true,
  );
  expect(() =>
    inspectOpencodeNativeAuth({ ...env, XDG_DATA_HOME: "relative" }),
  ).toThrow("absolute");
});
