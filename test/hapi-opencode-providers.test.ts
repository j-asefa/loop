import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  managedOpencodeConfig,
  managedOpencodeModels,
  validateManagedOpencodeVersion,
  validateManagedOpencodeProviders,
} from "../native/loopManaged";
const fixture = () => ({
  providers: [
    {
      id: "openai",
      options: {
        baseURL: "loop-subscription-only://openai/v1",
        apiKey: "opencode-oauth-dummy-key",
        headerTimeout: 300000,
      },
      models: {
        "gpt-5.4": {
          id: "gpt-5.4",
          providerID: "openai",
          api: { id: "gpt-5.4", npm: "@ai-sdk/openai", url: "" },
          headers: {},
        },
      },
    },
  ],
  default: { openai: "gpt-5.4" },
});
afterEach(() => vi.unstubAllEnvs());
it("accepts pinned native OAuth routing", () => {
  expect(() => validateManagedOpencodeProviders(fixture())).not.toThrow();
});
it.each([
  (x: any) => {
    x.providers[0].options.apiKey = "private-key";
  },
  (x: any) => {
    x.providers[0].options.baseURL = "https://api.openai.com/v1";
  },
  (x: any) => {
    x.providers[0].options.fetch = "injected";
  },
  (x: any) => {
    x.providers[0].key = "private-key";
  },
  (x: any) => {
    x.providers.push({ id: "other" });
  },
  (x: any) => {
    x.providers[0].models["gpt-5.4"].api.npm = "custom-sdk";
  },
  (x: any) => {
    x.providers[0].models["gpt-5.4"].providerID = "other";
  },
  (x: any) => {
    x.providers[0].models["gpt-5.4"].headers.Authorization = "private-key";
  },
  (x: any) => {
    x.default.openai = "missing";
  },
  (x: any) => {
    x.providers[0].models = {};
  },
])("rejects changed billing routes", (mutate) => {
  const value = fixture();
  mutate(value);
  expect(() => validateManagedOpencodeProviders(value)).toThrow(
    "OpenCode effective subscription model routing rejected",
  );
});
it("checks authenticated version and config endpoints in the executing directory and sanitizes native errors", async () => {
  const home = mkdtempSync(join(tmpdir(), "loop-model-guard-"));
  const binding = join(home, "binding.json");
  writeFileSync(binding, JSON.stringify({ flavor: "opencode", generation: 7 }));
  vi.stubEnv("LOOP_MANAGED", "1");
  vi.stubEnv("LOOP_LAUNCH_FILE", binding);
  vi.stubEnv("LOOP_ENVIRONMENT_GENERATION", "7");
  const paths: string[] = [];
  let bad = false;
  let version = "1.18.32";
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBe("Basic fixture");
    const url = new URL(req.url!, "http://localhost");
    expect(url.searchParams.get("directory")).toBe("/project space");
    paths.push(url.pathname);
    res.setHeader("Content-Type", "application/json");
    const config = {
      enabled_providers: ["openai"],
      provider: {
        openai: { options: { baseURL: "loop-subscription-only://openai/v1" } },
      },
    };
    res.end(
      JSON.stringify(
        url.pathname === "/global/health"
          ? {
              healthy: true,
              version,
              loopExecutionGuard: {
                revision: "loop-subscription-v1",
                active: true,
              },
            }
          : url.pathname === "/config"
            ? config
            : bad
              ? { secret: "never disclose" }
              : fixture(),
      ),
    );
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const run = () =>
      managedOpencodeConfig(
        `http://127.0.0.1:${address.port}`,
        "/project space",
        { Authorization: "Basic fixture" },
      );
    await expect(run()).resolves.toEqual(managedOpencodeModels(fixture()));
    expect(paths).toEqual(["/global/health", "/config", "/config/providers"]);
    paths.length = 0;
    version = "1.18.33";
    await expect(run()).rejects.toThrow("could not be verified");
    expect(paths).toEqual(["/global/health"]);
    version = "1.18.32";
    bad = true;
    await expect(run()).rejects.toThrow(
      "OpenCode effective subscription configuration could not be verified",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

it.each([
  null,
  {},
  { healthy: false, version: "1.18.32" },
  { healthy: true, version: "1.18.32-dev" },
  { healthy: true, version: "1.18.33" },
])("rejects unknown or unhealthy native versions", (health) => {
  expect(() => validateManagedOpencodeVersion(health)).toThrow(
    "audited version",
  );
});

it.each([
  undefined,
  { revision: "loop-subscription-v1", active: false },
  { revision: "other", active: true },
  { revision: "loop-subscription-v1", active: "true" },
])(
  "rejects missing or inactive execution enforcement",
  (loopExecutionGuard) => {
    expect(() =>
      validateManagedOpencodeVersion({
        healthy: true,
        version: "1.18.32",
        loopExecutionGuard,
      }),
    ).toThrow("active execution guard");
  },
);

it("projects native model IDs and default without exposing provider options", () => {
  const value = fixture();
  Object.assign(value.providers[0].models["gpt-5.4"], {
    name: "  Native model  ",
    secret: "private-value",
  });
  const models = managedOpencodeModels(value);
  expect(models).toEqual([
    {
      id: "openai/gpt-5.4",
      name: "Native model",
      isDefault: true,
      capabilities:
        "Native OpenCode model; availability depends on your account",
    },
  ]);
  expect(JSON.stringify(models)).not.toContain("private-value");
  expect(JSON.stringify(models)).not.toContain("apiKey");
});
it("rejects ambiguous model identities before returning any catalog", () => {
  const value = fixture();
  const model = value.providers[0].models["gpt-5.4"];
  delete (value.providers[0].models as any)["gpt-5.4"];
  (value.providers[0].models as any)["other/model"] = {
    ...model,
    id: "other/model",
  };
  value.default.openai = "other/model";
  expect(() => managedOpencodeModels(value)).toThrow("routing rejected");
});
