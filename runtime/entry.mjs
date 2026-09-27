import {
  RuntimeFailure,
  diagnosticText,
  errorSummary,
  runtimeFailureFacts,
} from "./diagnostics.mjs";
import { modelOptions } from "./model-options.mjs";
import { receiveSteering } from "./steering.mjs";
import { ClaudeSteering } from "./claude-steering.mjs";
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
  claudeModels,
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
  let threadId, stopSteering;
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
        throw new RuntimeFailure("Device sign-in unavailable");
      emit({ login: { url, code: login.userCode, acceptsCode: false } });
      while (true) {
        const m = await rpc.event();
        if (m.method === "account/login/completed") {
          if (!m.params.success)
            throw new RuntimeFailure("Sign-in was not completed");
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
        throw new RuntimeFailure("Subscription sign-in required");
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
            ...modelOptions(m),
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
    if (request.input.controlId && started.turn?.id) {
      stopSteering = receiveSteering(iterator, emit, (text) =>
        rpc.call("turn/steer", {
          threadId: thread.id,
          expectedTurnId: started.turn.id,
          input: [{ type: "text", text }],
        }),
      );
      emit({ steeringReady: true });
    }
    let answer = "";
    const traceMessages = new Map();
    while (true) {
      const m = await rpc.event();
      if (m.params?.threadId && m.params.threadId !== thread.id) continue;
      if (m.params?.turnId && m.params.turnId !== started.turn?.id) continue;
      // Redact before trace truncation so clipping cannot expose a token prefix.
      const trace = codexTrace(clean(m), traceMessages);
      if (trace) emit({ chunk: { trace: clean(trace) } });
      if (
        m.method === "turn/completed" &&
        m.params.turn?.id &&
        m.params.turn.id !== started.turn?.id
      )
        continue;
      if (m.method === "item/agentMessage/delta") {
        answer += m.params.delta;
        if (answer.length > 200000)
          throw new RuntimeFailure("Runtime output exceeds limit");
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
        stopSteering?.();
        if (m.params.turn.status !== "completed")
          throw new RuntimeFailure(
            `Codex turn ${m.params.turn.status || "failed"}: ${diagnosticText(clean(m.params.turn.error?.message)) || "The runtime did not provide a reason."}`,
            { phase: "turn", code: m.params.turn.error?.codexErrorInfo },
          );
        let output;
        if (!started.review) {
          try {
            output = JSON.parse(answer);
          } catch {
            throw new RuntimeFailure(
              "Codex returned an invalid structured response. Check Traces for saved progress.",
              { phase: "response", code: "invalid_json" },
            );
          }
        }
        for (const chunk of started.review
          ? [{ text: answer }]
          : resultChunks(output, request.input))
          emit({ chunk });
        emit({ chunk: { externalId: thread.id } });
        emit({ done: true });
        return;
      }
    }
  } finally {
    stopSteering?.();
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
    if (code !== 0) throw new RuntimeFailure("Sign-in was not completed");
  }
  if (request.action === "logout") {
    const p = launch("claude", ["auth", "logout"]);
    p.stdout.resume();
    const code = await new Promise((resolve, reject) => {
      p.once("error", reject);
      p.once("close", resolve);
    });
    if (code !== 0) throw new RuntimeFailure("Sign-out failed");
    emit({ result: { authenticated: false } });
    return;
  }
  const status = await claudeStatus();
  if (request.action !== "turn") {
    emit({
      result: {
        ...status,
        models: status.authenticated ? await claudeModels(launch) : [],
      },
    });
    return;
  }
  if (!status.authenticated)
    throw new RuntimeFailure("Claude subscription sign-in required");
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
    ...(request.input.effort ? ["--effort", request.input.effort] : []),
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    ...(command || request.input.controlId
      ? ["--input-format", "stream-json"]
      : []),
    "--json-schema",
    JSON.stringify(responseSchema),
  ]);
  let result,
    failure,
    initialized = false;
  let stopSteering, interruptReceipt;
  const steering = new ClaudeSteering();
  const user = (text) =>
    p.stdin.write(
      JSON.stringify({
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: text },
      }) + "\n",
    );
  const ready = () => {
    if (!request.input.controlId) {
      p.stdin.end();
      return;
    }
    stopSteering = receiveSteering(iterator, emit, async (text, id) => {
      try {
        await steering.steer(
          text,
          () =>
            new Promise((resolve, reject) => {
              interruptReceipt = { id, resolve, reject };
              p.stdin.write(
                JSON.stringify({
                  type: "control_request",
                  request_id: id,
                  request: { subtype: "interrupt" },
                }) + "\n",
              );
            }),
          async (value) => {
            result = undefined;
            user(value);
          },
        );
      } catch (error) {
        failure = error;
        p.kill();
        throw error;
      } finally {
        interruptReceipt = undefined;
      }
    });
    emit({ steeringReady: true });
  };
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
      if (
        interruptReceipt &&
        m.type === "control_response" &&
        m.response?.request_id === interruptReceipt.id
      ) {
        m.response.subtype === "success"
          ? interruptReceipt.resolve()
          : interruptReceipt.reject(new Error("Claude rejected interrupt"));
      }
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
        user(latestPrompt(request.input));
        ready();
      }
      if (m.type === "result") {
        if (steering.result()) return;
        result = m;
        stopSteering?.();
        if (request.input.controlId) p.stdin.end();
      }
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
  } else if (request.input.controlId) {
    user(turnPrompt(request.input, true));
    ready();
  } else p.stdin.end(turnPrompt(request.input, true));
  const { code, signal } = await new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(initializationTimer);
    stopSteering?.();
  });
  if (
    failure ||
    code !== 0 ||
    result?.is_error ||
    result?.subtype !== "success"
  )
    throw new RuntimeFailure(
      `Claude Code stopped (${signal ? `signal ${signal}` : `exit code ${code}`}${result?.subtype ? `, ${diagnosticText(clean(result.subtype))}` : ""}): ${diagnosticText(clean(failure?.message || (Array.isArray(result?.errors) ? result.errors.join("; ") : "") || (result?.is_error && typeof result.result === "string" ? result.result : ""))) || "No error details were returned."}`,
      { phase: "turn", exitCode: code, signal, subtype: result?.subtype },
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
    throw new RuntimeFailure("Unknown action");
  if (request.provider === "codex") await codex(request);
  else if (request.provider === "claude") await claude(request);
  else throw new RuntimeFailure("Unknown runtime");
} catch (error) {
  emit({
    code: error instanceof HarnessError ? "harness_command" : "runtime_failure",
    diagnostic: runtimeFailureFacts(error.details),
    error: diagnosticText(
      clean(
        error instanceof HarnessError || error instanceof RuntimeFailure
          ? error.message
          : errorSummary(error, [], false),
      ),
    ),
  });
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child?.kill("SIGTERM");
  input.close();
  process.stdin.destroy();
}
