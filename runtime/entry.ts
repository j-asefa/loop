import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { SessionRequest } from "./types.ts";
import {
  RuntimeFailure,
  diagnosticText,
  errorSummary,
  runtimeFailureFacts,
} from "./diagnostics.ts";
import { CodexSession } from "./codex-session.ts";
import { receiveSteering } from "./steering.ts";
import { ClaudeSteering } from "./claude-steering.ts";
// Official binaries are unmodified. Host mode is chosen by the local launcher,
// never by an HTTP request; the default remains a per-connection container.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { FileRejected, readPublishedChunk } from "./published-files.ts";
import { writeUploadChunk } from "./uploads.ts";
import { managedWorkspace, githubEnvironment } from "./workspace.ts";
import { cleanupStorage } from "./storage-cleanup.ts";
import {
  cleanupWorkspaces,
  workspaceCleanupInstructions,
} from "./workspace-cleanup.ts";
import { join } from "node:path";
import { redactValues } from "./redaction.ts";
import { claudeTraces, claudeActivities } from "./traces.ts";
import {
  claudeCatalog,
  claudeModels,
  slashCommand,
  latestPrompt,
  HarnessError,
} from "./harness.ts";
import {
  lines,
  nativeResponseSchema,
  turnPrompt,
  resultChunks,
  authorizationUrl,
} from "./protocol.ts";
const hostMode = process.env.LOOP_RUNTIME_MODE === "host";
let workdir = process.env.LOOP_RUNTIME_WORKDIR || process.cwd();
let githubToken: unknown;
const clean = (data: unknown) =>
  redactValues(data, githubToken ? [githubToken] : []);
const emit = (data: unknown) =>
  process.stdout.write(JSON.stringify(clean(data)) + "\n");
const input = createInterface({ input: process.stdin });
const iterator = input[Symbol.asyncIterator]();
const first = await iterator.next();
let child: ChildProcessWithoutNullStreams | undefined;
const stop = () => {
  child?.kill("SIGTERM");
  process.exit(1);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
let timeout: ReturnType<typeof setTimeout> | undefined;
// Never inherit an API key, alternate endpoint, cloud billing or parent credentials.
const env: NodeJS.ProcessEnv = hostMode
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
  mkdirSync(env.CODEX_HOME!, { recursive: true, mode: 0o700 });
  mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true, mode: 0o700 });
}
const launch = (bin: string, args: string[]) => {
  child = spawn(
    (hostMode && process.env.LOOP_RUNTIME_EXECUTABLE) || bin,
    args,
    {
      cwd: workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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
async function codex(request: SessionRequest) {
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
  const session = new CodexSession(p, {
    hostMode,
    home: env.HOME!,
    cwd: workdir,
  });
  let stopSteering: (() => void) | undefined;
  try {
    await session.run(
      request,
      emit,
      new AbortController().signal,
      (deliver) => {
        stopSteering?.();
        if (deliver && request.input?.controlId)
          stopSteering = receiveSteering(iterator, emit, deliver);
      },
    );
  } finally {
    stopSteering?.();
    session.rpc.close();
  }
}

async function claude(request: SessionRequest) {
  if (request.action === "capabilities") {
    emit({ result: await claudeCatalog(launch) });
    return;
  }
  if (request.action === "login") {
    const p = launch("claude", ["auth", "login", "--claudeai"]);
    let sent = false;
    const capture = (line: string) => {
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
    ...(request.input.model === "native-default"
      ? []
      : ["--model", request.input.model]),
    ...(request.input.effort ? ["--effort", request.input.effort] : []),
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    ...(command || request.input.controlId
      ? ["--input-format", "stream-json"]
      : []),
    "--json-schema",
    JSON.stringify(nativeResponseSchema(request.input)),
  ]);
  let result: any,
    failure: unknown,
    initialized = false;
  let stopSteering: (() => void) | undefined,
    interruptReceipt:
      | { id: string; resolve: () => void; reject: (error: unknown) => void }
      | undefined;
  const steering = new ClaudeSteering();
  const user = (text: string) =>
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
            new Promise<void>((resolve, reject) => {
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
  const internalToolIds = new Set<string>();
  const structuredTools = new Set<string>();
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
      for (const activity of claudeActivities(clean(m), structuredTools))
        emit({ chunk: { activity } });
      if (
        command &&
        m.type === "control_response" &&
        m.response?.request_id === "loop-command" &&
        !initialized
      ) {
        initialized = true;
        clearTimeout(
          initializationTimer as ReturnType<typeof setTimeout> | undefined,
        );
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
  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    p.once("error", reject);
    p.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(
      initializationTimer as ReturnType<typeof setTimeout> | undefined,
    );
    stopSteering?.();
  });
  if (
    failure ||
    code !== 0 ||
    result?.is_error ||
    result?.subtype !== "success"
  )
    throw new RuntimeFailure(
      `Claude Code stopped (${signal ? `signal ${signal}` : `exit code ${code}`}${result?.subtype ? `, ${diagnosticText(clean(result.subtype))}` : ""}): ${diagnosticText(clean((failure as Error | undefined)?.message || (Array.isArray(result?.errors) ? result.errors.join("; ") : "") || (result?.is_error && typeof result.result === "string" ? result.result : ""))) || "No error details were returned."}`,
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
  const request = JSON.parse(first.value as string);
  if (
    request.action === "project-brief" ||
    request.input?.nativeTools === false
  )
    throw new RuntimeFailure("Background projections are no longer supported");
  if (request.action !== "turn") timeout = setTimeout(stop, 30 * 60 * 1000);
  if (!hostMode) {
    if (
      ["turn", "capabilities", "read-file", "write-upload"].includes(
        request.action,
      )
    )
      workdir = managedWorkspace(
        env.HOME!,
        request.input?.workspaceKey ?? request.workspaceKey,
        request.action === "turn",
      );
    if (
      ["turn", "cleanup"].includes(request.action) &&
      request.githubToken !== undefined
    ) {
      Object.assign(env, githubEnvironment(request.githubToken));
      githubToken = request.githubToken;
    }
    if (request.action === "turn" && request.provider === "claude")
      request.input.instructions =
        (request.input.instructions || "") +
        `\nCurrent runtime: native shell, file editing and network tools are enabled. Your writable workspace is ${workdir}; files here persist across messages and runs. Use it for repository checkouts, edits and tests.` +
        (env.GH_TOKEN
          ? " Git and gh are authenticated with the workspace's connected GitHub account. Use them for the user's authorized repository work; never print or store authentication tokens."
          : "") +
        workspaceCleanupInstructions(workdir);
  }
  if (request.action === "cleanup") {
    if (hostMode)
      throw new RuntimeFailure(
        "Automatic workspace cleanup requires a managed Docker runtime.",
      );
    if (
      !Array.isArray(request.workspaceKeys) ||
      request.workspaceKeys.length > 100 ||
      request.workspaceKeys.some(
        (key: unknown) =>
          typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key),
      )
    )
      throw new RuntimeFailure("Invalid cleanup workspaces");
    let storage;
    try {
      storage = cleanupStorage({
        home: env.HOME!,
        workspaceKeys: request.workspaceKeys,
        dryRun: request.dryRun === true,
        recordProgress: request.dryRun === true,
      });
    } catch (error) {
      storage = [
        {
          kind: "maintenance",
          removed: false,
          reason: (error as Error).message,
        },
      ];
    }
    const results = request.githubToken
      ? await cleanupWorkspaces(
          request.workspaceKeys.map((key: string) =>
            join(env.HOME!, "workspaces", key),
          ),
          env,
          request.dryRun === true,
        )
      : [];
    emit({ result: { results, storage } });
  } else if (request.action === "read-file") {
    emit({
      result: readPublishedChunk(
        workdir,
        request.path,
        request.offset,
        request.version,
      ),
    });
  } else if (request.action === "write-upload") {
    // Managed uploads stay with the agent's workspace. A native host keeps
    // them out of the user's project directory.
    emit({
      result: writeUploadChunk(
        join(hostMode ? homedir() : workdir, ".loop", "uploads"),
        request,
      ),
    });
  } else if (
    !["login", "status", "logout", "turn", "capabilities"].includes(
      request.action,
    )
  ) {
    throw new RuntimeFailure("Unknown action");
  } else if (request.provider === "codex") await codex(request);
  else if (request.provider === "claude") await claude(request);
  else throw new RuntimeFailure("Unknown runtime");
} catch (error) {
  emit({
    code:
      error instanceof HarnessError
        ? "harness_command"
        : error instanceof FileRejected
          ? "file_rejected"
          : "runtime_failure",
    diagnostic: runtimeFailureFacts((error as RuntimeFailure).details),
    error: diagnosticText(
      clean(
        error instanceof HarnessError ||
          error instanceof RuntimeFailure ||
          error instanceof FileRejected
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
