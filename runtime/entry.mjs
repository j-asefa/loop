// Official binaries are unmodified. Host mode is chosen by the local launcher,
// never by an HTTP request; the default remains a per-connection container.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { nativeReply } from "./native-tools.mjs";
import { managedWorkspace, githubEnvironment } from "./workspace.mjs";
import { redactValues } from "./redaction.mjs";
import { codexTrace, claudeTraces } from "./traces.mjs";
import {
  codexCatalog,
  codexTurn,
  claudeCatalog,
  slashCommand,
  latestPrompt,
  HarnessError,
} from "./harness.mjs";
import {
  Rpc,
  lines,
  responseSchema,
  turnPrompt,
  resultChunks,
  authorizationUrl,
} from "./protocol.mjs";
const hostMode = process.env.LOOP_RUNTIME_MODE === "host";
let workdir = process.env.LOOP_RUNTIME_WORKDIR || process.cwd();
let githubToken;
const clean = (data) => redactValues(data, githubToken ? [githubToken] : []);
const emit = (data) => process.stdout.write(JSON.stringify(clean(data)) + "\n");
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
let timeout;
// Never inherit an API key, alternate endpoint, cloud billing or parent credentials.
const env = hostMode
  ? { ...process.env }
  : {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: `${process.env.HOME}/.codex`,
      CLAUDE_CONFIG_DIR: `${process.env.HOME}/.claude`,
      TERM: "dumb",
      NO_COLOR: "1",
      DISABLE_AUTOUPDATER: "1",
    };
// A native host keeps PATH, runtime homes, MCP credentials and project settings.
// Subscription connections must not silently pick up API billing or an alternate
// model backend from the shell that launched the service.
for (const key of [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "LOOP_RUNTIME_TOKEN",
  "LOOP_RUNTIME_TOKEN_FILE",
])
  delete env[key];
// Leave native defaults unset: a runtime may use the presence of a config-dir
// override to select a different keychain profile, even for the default path.
if (!hostMode) {
  mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
}
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
    ...(hostMode
      ? []
      : [
          "-c",
          'cli_auth_credentials_store="file"',
          // The managed environment is already allowlisted. Preserve the explicit
          // per-turn GitHub credential for native shell tools.
          "-c",
          'shell_environment_policy.inherit="all"',
          "-c",
          "shell_environment_policy.ignore_default_excludes=true",
        ]),
  ]);
  let threadId;
  const rpc = new Rpc(p, (m) => nativeReply(m, threadId));
  try {
    await rpc.call("initialize", {
      clientInfo: { name: "loop", version: "0.2.0" },
    });
    rpc.send({ method: "initialized", params: {} });
    if (request.action === "capabilities") {
      emit({
        result: codexCatalog(
          await rpc.call("skills/list", { cwds: [workdir], forceReload: true }),
        ),
      });
      return;
    }
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
      modelProvider: "openai",
      cwd: workdir,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      ephemeral: true,
    });
    threadId = thread.id;
    const started = await codexTurn(
      rpc,
      thread.id,
      request.input,
      true,
      workdir,
    );
    let answer = "";
    while (true) {
      const m = await rpc.event();
      if (m.params?.threadId && m.params.threadId !== thread.id) continue;
      if (m.params?.turnId && m.params.turnId !== started.turn?.id) continue;
      // Redact before trace truncation so clipping cannot expose a token prefix.
      const trace = codexTrace(clean(m));
      if (trace) emit({ chunk: { trace } });
      if (
        m.method === "turn/completed" &&
        m.params.turn?.id &&
        m.params.turn.id !== started.turn?.id
      )
        continue;
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
      if (
        started.review &&
        m.method === "item/completed" &&
        m.params.item?.type === "exitedReviewMode"
      )
        answer = m.params.item.review;
      if (m.method === "turn/completed") {
        if (m.params.turn.status !== "completed")
          throw new Error("Subscription run stopped or allowance exhausted");
        for (const chunk of started.review
          ? [{ text: answer }]
          : resultChunks(JSON.parse(answer), request.input))
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
  if (request.action === "capabilities") {
    emit({ result: await claudeCatalog(launch) });
    return;
  }
  if (request.action === "login") {
    const p = launch("claude", ["auth", "login", "--claudeai"]);
    let sent = false;
    const capture = (line) => {
      const url = authorizationUrl(line, "claude");
      if (url && !sent) {
        sent = true;
        emit({ login: { url, acceptsCode: true } });
      }
    };
    // Read complete lines: a pipe chunk can end halfway through the OAuth URL.
    for (const stream of [p.stdout, p.stderr])
      createInterface({ input: stream }).on("line", capture);
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
  const command = slashCommand(request.input);
  if (command) {
    const catalog = await claudeCatalog(launch);
    const selected = catalog.commands.find((c) => c.name === command);
    if (!selected || selected.disabledReason)
      throw new HarnessError(
        selected?.disabledReason ||
          "This command is unavailable on the selected machine. Refresh Commands & skills.",
      );
  }
  const p = launch("claude", [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    request.input.model,
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    ...(command ? ["--input-format", "stream-json"] : []),
    "--json-schema",
    JSON.stringify(responseSchema),
  ]);
  let result,
    failure,
    initialized = false;
  const internalToolIds = new Set();
  const initializationTimer = command
    ? setTimeout(() => {
        failure = new Error("Command initialization timed out");
        p.kill();
      }, 20000)
    : null;
  p.stdin.on("error", (error) => {
    failure = error;
    p.kill();
  });
  lines(
    p.stdout,
    (m) => {
      for (const trace of claudeTraces(clean(m), internalToolIds))
        emit({ chunk: { trace } });
      if (
        command &&
        m.type === "control_response" &&
        m.response?.request_id === "loop-command" &&
        !initialized
      ) {
        initialized = true;
        clearTimeout(initializationTimer);
        if (m.response.subtype !== "success") {
          failure = new Error("Command initialization failed");
          p.kill();
          return;
        }
        p.stdin.end(
          JSON.stringify({
            type: "user",
            session_id: "",
            parent_tool_use_id: null,
            message: { role: "user", content: latestPrompt(request.input) },
          }) + "\n",
        );
      }
      if (m.type === "result") result = m;
    },
    (e) => {
      failure = e;
      p.kill();
    },
  );
  if (command) {
    // Keep history off argv (Linux caps individual arguments at ~128 KiB).
    // The user message itself starts with / so Claude dispatches the command.
    p.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "loop-command",
        request: {
          subtype: "initialize",
          appendSystemPrompt: turnPrompt(
            { ...request.input, messages: request.input.messages.slice(0, -1) },
            true,
          ),
        },
      }) + "\n",
    );
  } else p.stdin.end(turnPrompt(request.input, true));
  const code = await new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("close", resolve);
  }).finally(() => clearTimeout(initializationTimer));
  if (
    failure ||
    code !== 0 ||
    result?.is_error ||
    result?.subtype !== "success"
  )
    throw new Error(
      "Subscription run stopped, model unavailable, or allowance exhausted",
    );
  for (const chunk of command &&
  !result.structured_output &&
  typeof result.result === "string"
    ? [{ text: result.result }]
    : resultChunks(result.structured_output, request.input))
    emit({ chunk });
  emit({ chunk: { externalId: result.session_id, usage: result.usage } });
  emit({ done: true });
}
try {
  const request = JSON.parse(first.value);
  if (request.action !== "turn") timeout = setTimeout(stop, 30 * 60 * 1000);
  if (!hostMode) {
    if (["turn", "capabilities"].includes(request.action))
      workdir = managedWorkspace(
        env.HOME,
        request.input?.workspaceKey ?? request.workspaceKey,
      );
    if (request.action === "turn" && request.githubToken !== undefined) {
      Object.assign(env, githubEnvironment(request.githubToken));
      githubToken = request.githubToken;
    }
    if (request.action === "turn")
      request.input.instructions =
        (request.input.instructions || "") +
        `\nCurrent runtime: native shell, file editing and network tools are enabled. Your writable workspace is ${workdir}; files here persist across messages and runs. Use it for repository checkouts, edits and tests.` +
        (env.GH_TOKEN
          ? " Git and gh are authenticated with the workspace's connected GitHub account. Use them for the user's authorized repository work; never print or store authentication tokens."
          : "");
  }
  if (
    !["login", "status", "logout", "turn", "capabilities"].includes(
      request.action,
    )
  )
    throw new Error("Unknown action");
  if (request.provider === "codex") await codex(request);
  else if (request.provider === "claude") await claude(request);
  else throw new Error("Unknown runtime");
} catch (error) {
  emit({
    ...(error instanceof HarnessError ? { code: "harness_command" } : {}),
    error:
      error instanceof HarnessError
        ? error.message
        : "The subscription runtime could not complete this request. Check sign-in, model access and subscription limits; API billing was not used.",
  });
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child?.kill("SIGTERM");
  input.close();
  process.stdin.destroy();
}
