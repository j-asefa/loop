// Synthetic credentials only; model dispatch must fail at the native execution guard.
// Usage: node native/check-opencode-policy.mjs /absolute/path/to/opencode
import assert from "node:assert/strict";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
const root = await mkdtemp(resolve(tmpdir(), "loop-opencode-policy-"));
const binary = resolve(process.argv[2]);
const password = randomBytes(24).toString("hex");
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
// Hold a native resource read so configuration changes happen while a real
// prompt request is active, before its first model dispatch. No model network
// request is needed: synthetic API auth remains a second refusal barrier.
let resourceEntered;
const readingResource = new Promise((resolve) => {
  resourceEntered = resolve;
});
let releaseResource;
const resourceReleased = new Promise((resolve) => {
  releaseResource = resolve;
});
const resourceServer = createHttpServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let data = "";
  for await (const chunk of req) data += chunk;
  const message = JSON.parse(data);
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  let result = {};
  if (message.method === "initialize")
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { resources: {} },
      serverInfo: { name: "loop-reload-fixture", version: "1" },
    };
  else if (message.method === "tools/list") result = { tools: [] };
  else if (message.method === "resources/list") result = { resources: [] };
  else if (message.method === "prompts/list") result = { prompts: [] };
  else if (message.method === "resources/read") {
    resourceEntered();
    await resourceReleased;
    result = {
      contents: [
        { uri: "fixture://reload", mimeType: "text/plain", text: "Reply OK" },
      ],
    };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
await new Promise((resolve) => resourceServer.listen(0, "127.0.0.1", resolve));
const config = {
  enabled_providers: ["openai"],
  model: "openai/gpt-5.4",
  small_model: "openai/gpt-5.4",
  provider: {
    openai: { options: { baseURL: "loop-subscription-only://openai/v1" } },
  },
  permission: "deny",
  mcp: {
    reload: {
      type: "remote",
      url: `http://127.0.0.1:${resourceServer.address().port}/mcp`,
      oauth: false,
    },
  },
};
const env = {
  PATH: process.env.PATH,
  HOME: root,
  XDG_CONFIG_HOME: root + "/config",
  XDG_DATA_HOME: root + "/data",
  XDG_STATE_HOME: root + "/state",
  XDG_CACHE_HOME: root + "/cache",
  OPENCODE_PURE: "1",
  LOOP_OPENCODE_SUBSCRIPTION_ONLY: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_SERVER_PASSWORD: password,
};
await mkdir(root + "/data/opencode", { recursive: true });
await writeFile(
  root + "/data/opencode/auth.json",
  JSON.stringify({
    openai: {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 9999999999999,
    },
  }),
  { mode: 0o600 },
);
const child = spawn(
  binary,
  ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
  { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
const exited = new Promise((resolve) => child.once("exit", resolve));
let startup = "";
child.stdout.on("data", (d) => {
  startup = (startup + d).slice(-6000);
});
child.stderr.on("data", (d) => {
  startup = (startup + d).slice(-6000);
});
const request = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization:
        "Basic " + Buffer.from("opencode:" + password).toString("base64"),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " at " + path);
  return res.json();
};
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null)
      throw new Error("Native process exit " + child.exitCode);
    try {
      await request("/global/health");
      ready = true;
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error("Server not ready");
  const effective = await request("/config");
  console.log(
    JSON.stringify({
      configGuard:
        effective.provider?.openai?.options?.baseURL ===
        config.provider.openai.options.baseURL,
      providerRestriction: effective.enabled_providers,
    }),
  );
  const outfile = resolve(root, "guard.mjs");
  await build({
    entryPoints: [new URL("../src/native-auth/account-policy.ts", import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { managedOpencodeConfig } = await import(pathToFileURL(outfile).href);
  const binding = resolve(root, "binding.json");
  await writeFile(
    binding,
    JSON.stringify({ flavor: "opencode", generation: 7 }),
    { mode: 0o600 },
  );
  process.env.LOOP_MANAGED = "1";
  process.env.LOOP_LAUNCH_FILE = binding;
  process.env.LOOP_ENVIRONMENT_GENERATION = "7";
  const headers = {
    Authorization:
      "Basic " + Buffer.from("opencode:" + password).toString("base64"),
  };
  const check = () =>
    managedOpencodeConfig(`http://127.0.0.1:${port}`, root, headers);
  await check();
  // Exercise the already-loaded OAuth provider after the native store changes.
  // The patched built-in hook must reject before ordinary fetch. No valid
  // credential is used, and the configured sink is not a network protocol.
  const replaceAuth = async (body) => {
    const result = await fetch(`http://127.0.0.1:${port}/auth/openai`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    assert.ok(result.ok, "native auth mutation succeeded");
  };
  await replaceAuth({ type: "api", key: "fixture-only-invalid" });
  const session = await request("/session", {});
  const result = await request(`/session/${session.id}/message`, {
    model: { providerID: "openai", modelID: "gpt-5.4" },
    parts: [{ type: "text", text: "Reply OK" }],
  });
  assert.ok(result.info?.error, "auth loss must fail the turn");
  assert.match(
    JSON.stringify(result.info.error),
    /Loop OpenCode subscription execution policy rejected/,
    "auth loss must be rejected by the native execution guard",
  );
  const activeSession = await request("/session", {});
  let activeSettled = false;
  const activePrompt = request(`/session/${activeSession.id}/message`, {
    model: { providerID: "openai", modelID: "gpt-5.4" },
    parts: [
      {
        type: "file",
        mime: "text/plain",
        filename: "reload.txt",
        url: "fixture://reload",
        source: {
          text: { value: "reload", start: 0, end: 6 },
          type: "resource",
          clientName: "reload",
          uri: "fixture://reload",
        },
      },
    ],
  }).finally(() => {
    activeSettled = true;
  });
  // Attach a rejection handler immediately while waiting for the barrier.
  void activePrompt.catch(() => {});
  await Promise.race([
    readingResource,
    activePrompt.then(() => {
      throw new Error("Native prompt settled before resource read");
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Native resource barrier not reached")),
        8000,
      ),
    ),
  ]);
  assert.equal(
    activeSettled,
    false,
    "native prompt must be active during reload",
  );
  // Global configuration reloads must be observed by the executing process.
  // Project config writes are intentionally disabled in this launch environment.
  const changed = await fetch(`http://127.0.0.1:${port}/global/config`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: {
        openai: {
          models: { "gpt-5.4": { headers: { "x-loop-fixture": "unsafe" } } },
        },
      },
    }),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  assert.ok(changed.ok, "native config mutation succeeded");
  // Wait for asynchronous instance disposal to expose the changed model.
  let reloaded = false;
  for (let i = 0; i < 40; i++) {
    const resolved = await request("/config/providers");
    const model = resolved.providers?.find((p) => p.id === "openai")?.models?.[
      "gpt-5.4"
    ];
    if (model?.headers?.["x-loop-fixture"] === "unsafe") {
      reloaded = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(reloaded, "executing native process loaded the changed model");
  releaseResource();
  // Native instance disposal can interrupt the in-flight HTTP request itself.
  // Either interruption or a native policy error is safe; a successful model
  // response is not. Inspect persisted history as well as the HTTP outcome.
  const activeResult = await activePrompt.catch((error) => {
    assert.equal(
      error.message,
      `HTTP 500 at /session/${activeSession.id}/message`,
    );
    return undefined;
  });
  if (activeResult) {
    assert.ok(
      activeResult.info?.error,
      "active native prompt must fail after reload",
    );
    assert.match(
      JSON.stringify(activeResult.info.error),
      /Failed to initialize provider: openai|Loop OpenCode subscription execution policy rejected/,
    );
  }
  const activeHistory = await request(`/session/${activeSession.id}/message`);
  assert.ok(
    !activeHistory.some(
      (message) =>
        message.info.role === "assistant" &&
        !message.info.error &&
        message.info.finish === "stop",
    ),
    "reload must not leave a successful model response",
  );
  // Bypass Loop preflight: the native SDK boundary must reject the reloaded
  // model. Invalid API auth is a second barrier against external OAuth traffic.
  await replaceAuth({ type: "api", key: "fixture-only-invalid" });
  const reloadedSession = await request("/session", {});
  const refused = await request(`/session/${reloadedSession.id}/message`, {
    model: { providerID: "openai", modelID: "gpt-5.4" },
    parts: [{ type: "text", text: "Reply OK" }],
  });
  assert.ok(refused.info?.error, "native dispatch after reload must fail");
  // SDK initialization failure precedes the OAuth fetch hook.
  assert.match(
    JSON.stringify(refused.info.error),
    /Failed to initialize provider: openai/,
  );
  // Compaction selects and invokes its model internally. Exercise the native
  // summarize route directly, with no Loop preflight, against existing history.
  const beforeCompaction = await request(
    `/session/${reloadedSession.id}/message`,
  );
  const previousIds = new Set(
    beforeCompaction.map((message) => message.info.id),
  );
  await request(`/session/${reloadedSession.id}/summarize`, {
    providerID: "openai",
    modelID: "gpt-5.4",
    auto: false,
  });
  const afterCompaction = await request(
    `/session/${reloadedSession.id}/message`,
  );
  const summary = afterCompaction.find(
    (message) =>
      !previousIds.has(message.info.id) &&
      message.info.role === "assistant" &&
      message.info.summary === true,
  );
  assert.ok(summary, "native compaction must attempt an internal model call");
  assert.match(
    JSON.stringify(summary.info.error),
    /Failed to initialize provider: openai/,
    "internal compaction must reject the unsafe reloaded model",
  );
  // A native subtask creates its own session and selects its model internally.
  // It must cross the same SDK boundary; checking only the parent's failure
  // could conceal a child that escaped the policy. All tool permissions stay
  // denied and the synthetic API credential remains in place.
  const parent = await request("/session", {});
  await request(`/session/${parent.id}/message`, {
    model: { providerID: "openai", modelID: "gpt-5.4" },
    parts: [
      {
        type: "subtask",
        agent: "explore",
        description: "Native policy regression",
        prompt: "Reply OK without using tools",
      },
    ],
  });
  const children = await request(`/session/${parent.id}/children`);
  assert.equal(children.length, 1, "native task must create exactly one child");
  const childMessages = await request(`/session/${children[0].id}/message`);
  const childFailure = childMessages.find(
    (message) => message.info.role === "assistant" && message.info.error,
  );
  assert.ok(childFailure, "native child must record a failed model call");
  assert.match(
    JSON.stringify(childFailure.info.error),
    /Failed to initialize provider: openai/,
    "internal subagent must reject the unsafe reloaded model",
  );
  await assert.rejects(check, /could not be verified/);
  console.log(
    "PASS: native health, effective config, resolved routing, native execution-guard auth-loss refusal, native SDK refusal after configuration reload, internal compaction and subagent refusal, active resource-read prompt reload refusal",
  );
} catch (error) {
  console.log(
    JSON.stringify({
      probeFailure: error.message,
      loaderFailure: /shared libraries|GLIBC|rosetta/.test(startup),
    }),
  );
  process.exitCode = 1;
} finally {
  releaseResource();
  resourceServer.closeAllConnections();
  await new Promise((resolve) => resourceServer.close(resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
