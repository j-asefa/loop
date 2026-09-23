// Executed ONLY inside a per-connection container. Official binaries are unmodified.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  Rpc,
  lines,
  responseSchema,
  turnPrompt,
  resultChunks,
  authorizationUrl,
} from "./protocol.mjs";
const workdir = process.env.LOOP_RUNTIME_WORKDIR || "/work";
const emit = (data) => process.stdout.write(JSON.stringify(data) + "\n");
const input = createInterface({ input: process.stdin });
const iterator = input[Symbol.asyncIterator]();
const first = await iterator.next();
let child;
const stop = () => {
  child?.kill("SIGTERM");
  process.exit(1);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const timeout = setTimeout(stop, 30 * 60 * 1000);
// Never inherit an API key, alternate endpoint, cloud billing or parent credentials.
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CODEX_HOME: `${process.env.HOME}/.codex`,
  CLAUDE_CONFIG_DIR: `${process.env.HOME}/.claude`,
  TERM: "dumb",
  NO_COLOR: "1",
  DISABLE_AUTOUPDATER: "1",
};
mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
const launch = (bin, args) => {
  child = spawn(bin, args, {
    cwd: workdir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  return child;
};
async function claudeStatus() {
  const p = launch("claude", ["auth", "status"]);
  let text = "";
  p.stdout.on("data", (b) => {
    text += b;
    if (text.length > 20000) p.kill();
  });
  await new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("close", resolve);
  });
  const s = JSON.parse(text);
  const authenticated = s.loggedIn === true && s.authMethod === "claude.ai";
  return {
    authenticated,
    authMode: authenticated ? "subscription" : "none",
    plan: s.subscriptionType || null,
  };
}
async function codex(request) {
  const p = launch("codex", [
    "app-server",
    "--stdio",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'cli_auth_credentials_store="file"',
    ...[
      "shell_tool",
      "unified_exec",
      "apps",
      "browser_use",
      "computer_use",
      "multi_agent",
      "code_mode",
      "code_mode_host",
    ].flatMap((f) => ["-c", `features.${f}=false`]),
    "-c",
    'web_search="disabled"',
  ]);
  const rpc = new Rpc(p);
  try {
    await rpc.call("initialize", {
      clientInfo: { name: "loop", version: "0.2.0" },
    });
    rpc.send({ method: "initialized", params: {} });
    if (request.action === "login") {
      const login = await rpc.call("account/login/start", {
        type: "chatgptDeviceCode",
      });
      const url = authorizationUrl(login.verificationUrl || "", "codex");
      if (!url || typeof login.userCode !== "string")
        throw new Error("Device sign-in unavailable");
      emit({ login: { url, code: login.userCode, acceptsCode: false } });
      while (true) {
        const m = await rpc.event();
        if (m.method === "account/login/completed") {
          if (!m.params.success) throw new Error("Sign-in was not completed");
          break;
        }
      }
    }
    if (request.action === "logout") {
      await rpc.call("account/logout");
      emit({ result: { authenticated: false } });
      return;
    }
    const { account } = await rpc.call("account/read", { refreshToken: true });
    if (account?.type !== "chatgpt") {
      if (request.action === "turn")
        throw new Error("Subscription sign-in required");
      emit({ result: { authenticated: false, models: [] } });
      return;
    }
    if (request.action !== "turn") {
      let cursor,
        models = [];
      do {
        const page = await rpc.call("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        models.push(
          ...page.data.map((m) => ({
            id: m.model || m.id,
            name: m.displayName || m.id,
            capabilities: "ChatGPT subscription · account catalog",
          })),
        );
        cursor = page.nextCursor;
      } while (cursor && models.length < 300);
      let limits = null;
      try {
        limits = await rpc.call("account/rateLimits/read");
      } catch {}
      emit({
        result: {
          authenticated: true,
          authMode: "subscription",
          plan: account.planType,
          models,
          limits,
        },
      });
      return;
    }
    const { thread } = await rpc.call("thread/start", {
      model: request.input.model,
      cwd: workdir,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    });
    await rpc.call("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: turnPrompt(request.input) }],
      outputSchema: responseSchema,
    });
    let answer = "";
    while (true) {
      const m = await rpc.event();
      if (m.method === "item/agentMessage/delta") {
        answer += m.params.delta;
        if (answer.length > 200000)
          throw new Error("Runtime output exceeds limit");
      }
      if (
        m.method === "item/completed" &&
        m.params.item?.type === "agentMessage"
      )
        answer = m.params.item.text;
      if (m.method === "turn/completed") {
        if (m.params.turn.status !== "completed")
          throw new Error("Subscription run stopped or allowance exhausted");
        for (const chunk of resultChunks(JSON.parse(answer), request.input))
          emit({ chunk });
        emit({ chunk: { externalId: thread.id } });
        emit({ done: true });
        return;
      }
    }
  } finally {
    rpc.close();
  }
}
async function claude(request) {
  if (request.action === "login") {
    const p = launch("claude", ["auth", "login", "--claudeai"]);
    let output = "",
      sent = false;
    const capture = (b) => {
      output = (output + String(b)).slice(-16000);
      const url = authorizationUrl(output, "claude");
      if (url && !sent) {
        sent = true;
        emit({ login: { url, acceptsCode: true } });
      }
    };
    p.stdout.on("data", capture);
    p.stderr.on("data", capture);
    // Forward the one-time code to the native CLI; never exchange/store OAuth tokens in Loop.
    void (async () => {
      for await (const line of iterator) {
        const m = JSON.parse(line);
        if (typeof m.code === "string" && m.code.length < 4096)
          p.stdin.write(m.code.replace(/[\r\n]/g, "") + "\n");
      }
    })().catch(() => p.kill());
    const code = await new Promise((resolve, reject) => {
      p.once("error", reject);
      p.once("close", resolve);
    });
    if (code !== 0) throw new Error("Sign-in was not completed");
  }
  if (request.action === "logout") {
    const p = launch("claude", ["auth", "logout"]);
    p.stdout.resume();
    const code = await new Promise((resolve, reject) => {
      p.once("error", reject);
      p.once("close", resolve);
    });
    if (code !== 0) throw new Error("Sign-out failed");
    emit({ result: { authenticated: false } });
    return;
  }
  const status = await claudeStatus();
  if (request.action !== "turn") {
    // CLI aliases, not a fabricated account-discovery endpoint. Access checked by the native runtime.
    emit({
      result: {
        ...status,
        models: status.authenticated
          ? ["sonnet", "opus", "haiku"].map((id) => ({
              id,
              name: id,
              capabilities:
                "Claude Code alias · availability depends on your subscription",
            }))
          : [],
      },
    });
    return;
  }
  if (!status.authenticated)
    throw new Error("Claude subscription sign-in required");
  const p = launch("claude", [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    request.input.model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--max-turns",
    "3",
    "--json-schema",
    JSON.stringify(responseSchema),
  ]);
  let result, failure;
  lines(
    p.stdout,
    (m) => {
      if (m.type === "result") result = m;
    },
    (e) => {
      failure = e;
      p.kill();
    },
  );
  p.stdin.end(turnPrompt(request.input));
  const code = await new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("close", resolve);
  });
  if (
    failure ||
    code !== 0 ||
    result?.is_error ||
    result?.subtype !== "success"
  )
    throw new Error(
      "Subscription run stopped, model unavailable, or allowance exhausted",
    );
  for (const chunk of resultChunks(result.structured_output, request.input))
    emit({ chunk });
  emit({ chunk: { externalId: result.session_id, usage: result.usage } });
  emit({ done: true });
}
try {
  const request = JSON.parse(first.value);
  if (!["login", "status", "logout", "turn"].includes(request.action))
    throw new Error("Unknown action");
  if (request.provider === "codex") await codex(request);
  else if (request.provider === "claude") await claude(request);
  else throw new Error("Unknown runtime");
} catch {
  emit({
    error:
      "The subscription runtime could not complete this request. Check sign-in, model access and subscription limits; API billing was not used.",
  });
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child?.kill("SIGTERM");
  input.close();
  process.stdin.destroy();
}
