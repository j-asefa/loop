import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runnerSignIns } from "../src/native-auth/runner.js";

test("OpenCode runner sign-in uses native credential homes and excludes host auth overrides", async () => {
  const source = {
    HOME: "/runner/home",
    XDG_DATA_HOME: "/runner/data",
    XDG_CONFIG_HOME: "/runner/config",
    PATH: "/runner/bin",
    OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api","key":"fixture"}}',
    OPENCODE_CONFIG: "/host/custom.json",
    OPENCODE_CONFIG_DIR: "/host/plugins",
    OPENCODE_CONFIG_CONTENT: '{"provider":{"openai":{}}}',
    OPENCODE_PURE: "0",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_EXPERIMENTAL: "1",
    OPENAI_API_KEY: "fixture",
    OPENAI_BASE_URL: "https://billing.invalid",
    CODEX_API_KEY: "fixture",
    GOOGLE_API_KEY: "fixture",
    ANTHROPIC_AUTH_TOKEN: "fixture",
    AZURE_OPENAI_ENDPOINT: "https://billing.invalid",
    AWS_PROFILE: "billing",
    SOME_PROVIDER_API_KEY: "fixture",
    NODE_OPTIONS: "--import=/host/hook.mjs",
    BUN_OPTIONS: "--preload=/host/hook.mjs",
  };
  const snapshot = { ...source };
  const seen: NodeJS.ProcessEnv[] = [];
  const auth = runnerSignIns(async (options) => {
    seen.push(options.env!);
    return {
      providers: async () => [],
      login: async () => {},
      dispose: async () => {},
    };
  });
  try {
    await auth.catalog({
      name: "opencode",
      executable: "/runner/opencode",
      project: "/project",
      env: source,
    });
    assert.deepEqual(seen[0], {
      HOME: source.HOME,
      XDG_DATA_HOME: source.XDG_DATA_HOME,
      XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
      PATH: source.PATH,
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    });
    assert.deepEqual(source, snapshot);
    // Managed Pi uses the same native homes with its launch allowlist.
    await auth.catalog({
      name: "pi",
      executable: "/runner/pi",
      project: "/project",
      env: source,
    });
    assert.deepEqual(seen[1], { HOME: source.HOME, PATH: source.PATH, XDG_DATA_HOME: source.XDG_DATA_HOME, XDG_CONFIG_HOME: source.XDG_CONFIG_HOME });
  } finally {
    await auth.close();
  }
});

test("runner catalog and command boundary enforce provider and billing methods", async () => {
  const calls: string[] = [];
  const auth = runnerSignIns(async () => ({
    providers: async () => [
      {
        id: "openai",
        name: "OpenAI",
        methods: [
          { id: "0", label: "ChatGPT", type: "oauth" },
          { id: "1", label: "API key", type: "api" },
        ],
      },
      {
        id: "anthropic",
        name: "Claude",
        methods: [
          { id: "oauth", label: "Claude", type: "oauth" },
          { id: "console", label: "Console", type: "oauth" },
        ],
      },
    ],
    login: async (provider, method) => {
      calls.push(provider + ":" + method);
    },
    dispose: async () => {},
  }));
  try {
    const options = {
      name: "opencode",
      executable: "fixture",
      project: tmpdir(),
      env: { HOME: "/runner/home" },
    };
    assert.deepEqual(
      (await auth.catalog(options)).providers.map((p) => [
        p.id,
        p.methods.map((m) => m.id),
      ]),
      [["openai", ["0"]]],
    );
    await assert.rejects(auth.start(options, "openai", "1", "api"), /offered/);
    await assert.rejects(
      auth.start(options, "anthropic", "oauth", "other"),
      /offered/,
    );
    const claude = { ...options, name: "claude" };
    assert.deepEqual(
      (await auth.catalog(claude)).providers[0].methods.map((m) => m.id),
      ["oauth"],
    );
    await assert.rejects(
      auth.start(claude, "anthropic", "console", "console"),
      /offered/,
    );
    assert.equal(calls.length, 0);
    await auth.start(options, "openai", "0", "allowed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["openai:0"]);
    assert.equal(
      (await auth.catalog({ ...options, name: "pi" })).providers.length,
      2,
    );
  } finally {
    await auth.close();
  }
});

test("runner refuses ambient host environments before starting a driver", async () => {
  let called = false;
  const auth = runnerSignIns(async () => {
    called = true;
    throw new Error("fixture");
  });
  try {
    await assert.rejects(
      auth.catalog({
        name: "opencode",
        executable: "fixture",
        project: tmpdir(),
      }),
    );
    assert.equal(called, false);
  } finally {
    await auth.close();
  }
});

test("a changed runner credential home cannot reuse an active sign-in driver", async () => {
  const homes: (string | undefined)[] = [];
  const auth = runnerSignIns(async (options) => {
    homes.push(options.env?.HOME);
    return {
      providers: async () => [
        {
          id: "openai",
          name: "ChatGPT",
          methods: [{ id: "oauth", label: "ChatGPT", type: "oauth" }],
        },
      ],
      login: async (_p, _m, io) => {
        await io.prompt({ type: "manual_code", message: "Code" });
      },
      dispose: async () => {},
    };
  });
  const options = {
    name: "codex",
    executable: "fixture",
    project: tmpdir(),
    env: { HOME: "/runner/one" },
  };
  try {
    const view = await auth.start(options, "openai", "oauth", "first");
    options.env.HOME = "/runner/two";
    await assert.rejects(auth.catalog(options), /Finish or cancel/);
    assert.deepEqual(homes, ["/runner/one"]);
    await auth.cancel("codex", view.attempt!.id);
    await auth.catalog(options);
    assert.deepEqual(homes, ["/runner/one", "/runner/two"]);
  } finally {
    await auth.close();
  }
});

test("runner artifact imports independently of Loop database and ships extension at its relative path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-runner-auth-"));
  try {
    const { buildNativeAuth } =
      // @ts-expect-error Build helper is intentionally a plain Node module.
      await import("../scripts/build-native-auth.mjs");
    const metadata = await buildNativeAuth(dir);
    assert.equal(
      Object.keys(metadata.inputs).some((p) =>
        /server\/(db|domain)\.ts|better-sqlite3/.test(p),
      ),
      false,
    );
    const { runnerSignIns: bundled, inspectOpencodeNativeAuth } = await import(
      pathToFileURL(join(dir, "native-auth/service.mjs")).href
    );
    assert.equal(inspectOpencodeNativeAuth({ HOME: dir }).authenticated, false);
    const auth = bundled(async () => ({
      providers: async () => [],
      dispose: async () => {},
    }));
    assert.deepEqual(
      await auth.catalog({
        name: "pi",
        executable: "fixture",
        project: dir,
        env: { HOME: "/runner/home" },
      }),
      { providers: [], attempt: undefined },
    );
    await auth.close();
    await access(join(dir, "pi-auth-extension.mjs"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker sign-in protocol preserves legacy views and fences rich input", async () => {
  const { runnerLoginApi } = await import("../src/native-auth/runner.js");
  const seen: string[] = [];
  let starts = 0;
  const auth = runnerSignIns(async (options) => {
    assert.equal(options.executable, "/runner/codex");
    assert.deepEqual(options.env, { HOME: "/runner" });
    return {
      providers: async () => [
        {
          id: "openai",
          name: "ChatGPT",
          methods: [{ id: "oauth", label: "ChatGPT", type: "oauth" }],
        },
      ],
      login: async (_p, _m, io) => {
        starts++;
        io.link("https://auth.openai.com/device", "ABCD-EFGH");
        seen.push(await io.prompt({ type: "manual_code", message: "Code" }));
      },
      dispose: async () => {},
    };
  });
  const api = runnerLoginApi((name) => {
    if (name !== "codex") throw new Error("Unsupported provider");
    return {
      name,
      executable: "/runner/codex",
      project: "/project",
      env: { HOME: "/runner" },
    };
  }, auth);
  try {
    await assert.rejects(api.request("providers", { flavor: "pi" }));
    await Promise.all([
      api.request("start", {
        flavor: "codex",
        executable: "/evil",
        env: { HOME: "/evil" },
      }),
      api.request("start", { flavor: "codex" }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    const status = await api.request("status", { flavor: "codex" });
    assert.equal(starts, 1);
    assert.equal(status.state, "waiting");
    assert.ok("id" in status);
    assert.equal(status.login?.code, "ABCD-EFGH");
    assert.equal(status.login?.acceptsCode, true);
    assert.equal(status.id, status.attempt?.id);
    await assert.rejects(
      api.request("input", {
        flavor: "codex",
        attemptId: status.id,
        promptId: "00000000-0000-4000-8000-000000000001",
        value: "stale",
      }),
      /ended/,
    );
    await api.request("input", {
      flavor: "codex",
      attemptId: status.id,
      promptId: status.attempt!.prompt!.id,
      value: "answer",
    });
    await assert.rejects(
      api.request("code", {
        flavor: "codex",
        attemptId: status.id,
        code: "replay",
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["answer"]);
    const complete = await api.request("status", { flavor: "codex" });
    assert.equal(complete.state, "complete");
    assert.ok("id" in complete);
    assert.equal(complete.login, undefined);
  } finally {
    await api.close();
  }
});
