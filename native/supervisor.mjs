// One container per worker. Restart tears down children; durable native state
// survives, and Loop must reconcile before explicit cold resume.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { configureClaudeUsage } from "./subscription-usage.mjs";
const settings = JSON.parse(
  readFileSync(process.env.LOOP_WORKER_CONFIG, "utf8"),
);
const container = process.env.LOOP_EXECUTION_KIND === "docker";
for (const key of Object.keys(process.env))
  if (
    /^(OPENAI_|ANTHROPIC_|AZURE_OPENAI_|AWS_|GOOGLE_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY)/.test(
      key,
    )
  )
    delete process.env[key];
Object.assign(process.env, {
  HAPI_RUNNER_SUPERVISED: "0",
  HAPI_DISABLE_VERSION_HANDOFF: "1",
  HAPI_API_URL: `http://127.0.0.1:${settings.hapiBridgePort || 3013}`,
  LOOP_MANAGED: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_USE_BEDROCK: "0",
  CLAUDE_CODE_USE_VERTEX: "0",
});
// Pin HAPI launch to the same host-resolved executable used for sign-in/status.
// Never inherit a caller override or rely on PATH ordering for guarded OpenCode.
delete process.env.HAPI_OPENCODE_PATH;
if (settings.providers?.includes("opencode")) {
  if (!isAbsolute(settings.opencodeBinary || ""))
    throw new Error("Managed OpenCode requires an absolute executable path");
  process.env.HAPI_OPENCODE_PATH = settings.opencodeBinary;
}
delete process.env.HAPI_PI_PATH;
delete process.env.LOOP_PI_EXTENSION;
if (settings.providers?.includes("pi")) {
  if (!isAbsolute(settings.piBinary || ""))
    throw new Error("Managed Pi requires an absolute executable path");
  process.env.HAPI_PI_PATH = settings.piBinary;
  process.env.LOOP_PI_EXTENSION = fileURLToPath(new URL("./generated/pi-managed-extension.mjs", import.meta.url));
}
// One authenticated Codex engine per native worker. HAPI execution processes
// attach separate threads to it; they never own or terminate this process.
const codexToken = randomBytes(32).toString("hex");
process.env.LOOP_CODEX_APP_SERVER_ENDPOINT = `ws://127.0.0.1:${settings.codexPort || 3014}`;
process.env.LOOP_CODEX_APP_SERVER_TOKEN = codexToken;
// This container is the sole supervisor for its HAPI runner. Its previous
// process tree cannot survive a container restart, but the PID-only HAPI lock
// can: a reused PID could make start-sync mistake a stale runner for a live one.
for (const file of container
  ? ["runner.state.json", "runner.state.json.lock"]
  : []) {
  try {
    unlinkSync(join(process.env.HAPI_HOME || "/home/agent/.hapi", file));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Could not recover stale HAPI runner state");
  }
}
// Codex refuses to start when CODEX_HOME is missing, and a bind-mounted
// /home/agent hides the directory baked into the image.
if (process.env.CODEX_HOME)
  mkdirSync(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
if (!settings.providers || settings.providers.includes("claude")) {
  const claudeHome = settings.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(settings.nativeHome, ".claude");
  configureClaudeUsage(claudeHome, fileURLToPath(new URL("./claude-usage-hook.mjs", import.meta.url)));
}
const children = [];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      container ? process.kill(-child.pid, "SIGTERM") : child.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const child of children) {
      try {
        container ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL");
      } catch {}
    }
  }, 5000).unref();
  setTimeout(() => process.exit(1), 10000).unref();
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
const commands = [
  [
    settings.codexBinary,
    [
      "app-server",
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'model_provider="openai"',
      "--listen",
      process.env.LOOP_CODEX_APP_SERVER_ENDPOINT,
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      createHash("sha256").update(codexToken).digest("hex"),
    ],
  ],
  [
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), "worker.mjs")],
  ],
  [
    settings.hapiBinary || "hapi",
    ["runner", "start-sync", "--workspace-root", process.env.LOOP_PROJECT_ROOT],
  ],
];
if (settings.providers && !settings.providers.includes("codex"))
  commands.shift();
for (const [command, args] of commands) {
  const env = { ...process.env };
  if (command === settings.codexBinary) {
    delete env.CLI_API_TOKEN;
    for (const key of Object.keys(env))
      if (key.startsWith("LOOP_") && key !== "LOOP_SESSION_TOKEN")
        delete env[key];
    delete env.LOOP_CODEX_APP_SERVER_TOKEN;
    delete env.LOOP_CODEX_APP_SERVER_ENDPOINT;
  }
  const child = spawn(command, args, {
    detached: container,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(
      `[supervisor] ${command} child could not start: ${error.message}`,
    );
    stop();
  });
  child.on("exit", (code, signal) => {
    console.error(
      `[supervisor] ${command} child exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
    stop();
  });
}
