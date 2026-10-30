// Real pinned Codex, unsigned-in temporary HOME, no model requests or network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Rpc } from "../runtime/protocol.ts";
const home = mkdtempSync(join(tmpdir(), "loop55-shared-codex-smoke-"));
mkdirSync(join(home, ".codex"));
const child = spawn(
  "codex",
  [
    "app-server",
    "--stdio",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'cli_auth_credentials_store="file"',
  ],
  {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
child.stderr.resume();
const rpc = new Rpc(child);
const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
try {
  await rpc.call("initialize", {
    clientInfo: { name: "loop55-smoke", version: "0.2.0" },
  });
  rpc.send({ method: "initialized", params: {} });
  const start = async (name) => {
    const cwd = join(home, name);
    mkdirSync(cwd);
    return rpc.call("thread/start", {
      cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      ephemeral: true,
      config: {
        forced_login_method: "chatgpt",
        "shell_environment_policy.set": { LOOP55_SMOKE_MARKER: name },
      },
    });
  };
  const [a, b] = await Promise.all([start("first"), start("second")]);
  assert.notEqual(a.thread.id, b.thread.id);
  const loaded = await rpc.call("thread/loaded/list");
  assert.ok(
    loaded.data.includes(a.thread.id) && loaded.data.includes(b.thread.id),
  );
  // The real shell-command protocol checks per-thread cwd/environment without
  // invoking a model or reading any signed-in account.
  await Promise.all(
    [a, b].map(({ thread }) =>
      rpc.call("thread/shellCommand", {
        threadId: thread.id,
        command: 'printf "%s:%s" "$LOOP55_SMOKE_MARKER" "$PWD"',
        timeoutMs: 5000,
      }),
    ),
  );
  const output = new Map();
  while (output.size < 2) {
    const event = await rpc.event();
    if (
      event.method === "item/completed" &&
      event.params.item?.type === "commandExecution"
    )
      output.set(event.params.threadId, event.params.item.aggregatedOutput);
  }
  assert.ok(output.get(a.thread.id).includes("first:" + join(home, "first")));
  assert.ok(output.get(b.thread.id).includes("second:" + join(home, "second")));
  await rpc.call("thread/unsubscribe", { threadId: a.thread.id });
  await rpc.call("thread/unsubscribe", { threadId: b.thread.id });
  console.log(
    "PASS: one real Codex app-server runs two threads with isolated cwd/environment; no model inference.",
  );
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    rpc.close();
    await closed;
  }
  rmSync(home, { recursive: true, force: true });
}
