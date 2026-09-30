// Run after apply-hapi-patch.mjs: node native/check-opencode-http.mjs <hapi-root>
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2]);
const temp = await mkdtemp(join(tmpdir(), "loop-http-bridge-"));
try {
  const modules = {};
  for (const name of [
    "opencodeCompactBridge",
    "opencodeEventStream",
    "opencodeBackend",
  ]) {
    const outfile = join(temp, name + ".mjs");
    await build({
      entryPoints: [join(root, "cli/src/opencode/utils", name + ".ts")],
      alias: {
        "@hapi/protocol": join(root, "shared/src/utils.ts"),
        "@/loopManaged": join(root, "cli/src/loopManaged.ts"),
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      plugins: [
        {
          name: "fixture-logger",
          setup(b) {
            const mocks = {
              "@/agent/backends/acp":
                "export class AcpSdkBackend { constructor(options) { this.options = options; } }",
              "@/utils/invokedCwd":
                "export const getInvokedCwd = () => '/fixture';",
              "@/agent/agentLaunchCommand":
                "export const getAgentLaunchCommand = () => '/fixture/opencode';",
            };
            b.onResolve(
              {
                filter:
                  /^@\/(agent\/backends\/acp|utils\/invokedCwd|agent\/agentLaunchCommand)$/,
              },
              (args) => ({ path: args.path, namespace: "backend-fixture" }),
            );
            b.onLoad(
              { filter: /.*/, namespace: "backend-fixture" },
              (args) => ({ contents: mocks[args.path] }),
            );
            b.onResolve({ filter: /^@\/ui\/logger$/ }, () => ({
              path: "logger",
              namespace: "fixture",
            }));
            b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents:
                "export const logger = { debug() {}, warn() {}, info() {}, error() {} };",
            }));
          },
        },
      ],
    });
    modules[name] = await import(pathToFileURL(outfile).href);
  }
  const savedEnv = { ...process.env };
  try {
    await mkdir(join(temp, "data/opencode"), { recursive: true });
    await writeFile(
      join(temp, "data/opencode/auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "fixture",
          refresh: "fixture",
          expires: 1,
        },
      }),
    );
    const binding = join(temp, "launch.json");
    await writeFile(
      binding,
      JSON.stringify({
        flavor: "opencode",
        generation: 1,
        billing: { requiredAuth: "chatgpt", allowApiFallback: false },
      }),
    );
    Object.assign(process.env, {
      HOME: temp,
      XDG_DATA_HOME: join(temp, "data"),
      LOOP_MANAGED: "1",
      LOOP_LAUNCH_FILE: binding,
      LOOP_ENVIRONMENT_GENERATION: "1",
      OPENAI_API_KEY: "host-key",
      OPENCODE_AUTH_CONTENT: "host-auth",
      OPENCODE_SERVER_PASSWORD: "host-password",
    });
    const backend = modules.opencodeBackend.createOpencodeBackend({
      cwd: temp,
      port: 12345,
      hostname: "127.0.0.1",
      serverEnv: {
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: "process-password",
      },
    });
    assert.equal(backend.options.env.OPENAI_API_KEY, undefined);
    assert.equal(backend.options.env.OPENCODE_AUTH_CONTENT, undefined);
    assert.equal(backend.options.env.XDG_DATA_HOME, join(temp, "data"));
    assert.equal(
      backend.options.env.OPENCODE_SERVER_PASSWORD,
      "process-password",
    );
    assert.equal(
      JSON.parse(backend.options.env.OPENCODE_CONFIG_CONTENT).provider.openai
        .options.baseURL,
      "loop-subscription-only://openai/v1",
    );
    assert.throws(
      () => modules.opencodeBackend.createOpencodeBackend({ cwd: temp }),
      /authentication required/,
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
  const headers = { Authorization: "Basic fixture-only" };
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers.Authorization, headers.Authorization);
    assert.equal(init.redirect, "error");
    calls++;
    return Response.json(init.method === "POST" ? {} : []);
  };
  const opts = {
    baseUrl: "http://127.0.0.1:1",
    sessionId: "fixture",
    headers,
    signal: new AbortController().signal,
    fetchImpl,
  };
  const bridge = modules.opencodeCompactBridge;
  await bridge.captureCompactionMarkerSnapshot(opts);
  await bridge.triggerOpencodeCompact({
    ...opts,
    providerId: "openai",
    modelId: "fixture",
  });
  await bridge.fetchCompactionResult({ ...opts, markerIdsBefore: [] });
  assert.equal(calls, 3);
  let received;
  const ready = new Promise((r) => {
    received = r;
  });
  const subscription = modules.opencodeEventStream.subscribeToOpencodeEvents({
    ...opts,
    directory: "/fixture",
    onRetry() {},
    fetchImpl: async (_url, init) => {
      try {
        assert.equal(init.headers.Authorization, headers.Authorization);
        assert.equal(init.redirect, "error");
        received();
      } catch (error) {
        received(error);
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      );
    },
  });
  try {
    const result = await Promise.race([
      ready,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Event request not observed")),
          2000,
        );
        timer.unref();
      }),
    ]);
    if (result) throw result;
  } finally {
    subscription.close();
  }
  console.log(
    "PASS: launch environment is isolated; compaction and events authenticate without redirects",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
