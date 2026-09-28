import {
  RuntimeFailure,
  diagnosticText,
  runtimeFailureFacts,
} from "./diagnostics.mjs";
import { idleDeadline, IdleTimeoutError } from "./idle-deadline.mjs";
import { containerArgs } from "./container.mjs";
import { mcpHandler } from "./mcp.mjs";
// Private control plane. Only this service has the Docker socket, never model containers.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lines } from "./protocol.mjs";
import { SteeringControls } from "./steering.mjs";
import {
  loginDeadline,
  LoginTimeoutError,
  LOGIN_START_MS,
} from "./login-deadline.mjs";
const hostMode = process.env.LOOP_RUNTIME_MODE === "host";
const workdir = hostMode
  ? realpathSync(process.env.LOOP_RUNTIME_WORKDIR || process.cwd())
  : undefined;
const token = process.env.LOOP_RUNTIME_TOKEN_FILE
  ? readFileSync(process.env.LOOP_RUNTIME_TOKEN_FILE, "utf8").trim()
  : process.env.LOOP_RUNTIME_TOKEN;
if (!token || token.length < 32)
  throw new Error("Set LOOP_RUNTIME_TOKEN with scripts/setup.mjs");
const prefix =
  "loop-sub-" + createHash("sha256").update(token).digest("hex").slice(0, 12);
const image = process.env.LOOP_RUNTIME_IMAGE || "loop-runtime:0.2";
const pending = new Map(),
  active = new Map(),
  logins = new Map(),
  generations = new Map();
const MAX_ACTIVE = 8;
function authorized(header) {
  const a = Buffer.from(header || ""),
    b = Buffer.from("Bearer " + token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function docker(args) {
  return spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
}
async function remove(name) {
  const p = docker(["rm", "-f", name]);
  p.stdout.resume();
  p.stderr.resume();
  await new Promise((resolve) => {
    p.once("error", resolve);
    p.once("close", resolve);
  });
}
async function execute(key, request, onEvent, signal) {
  if (active.size >= MAX_ACTIVE)
    throw new Error("Runtime capacity reached. Retry later.");
  const name = `${prefix}-${randomUUID()}`;
  const p = hostMode
    ? spawn(
        process.execPath,
        [fileURLToPath(new URL("./entry.mjs", import.meta.url))],
        {
          cwd: workdir,
          env: { ...process.env, LOOP_RUNTIME_WORKDIR: workdir },
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
    : docker(containerArgs(prefix, key, image, name));
  let result,
    error,
    exitSignal,
    closed = false;
  const cancel = (force = false) => {
    const killSignal = force === true ? "SIGKILL" : "SIGTERM";
    if (hostMode && process.platform !== "win32" && p.pid) {
      try {
        process.kill(-p.pid, killSignal);
      } catch {}
    } else p.kill(killSignal);
    if (!hostMode) void remove(name);
  };
  const deadline =
    request.action === "login"
      ? loginDeadline((failure) => {
          error = failure;
          cancel();
        })
      : null;
  const timer =
    deadline || request.action === "turn"
      ? null
      : setTimeout(cancel, 30 * 60 * 1000);
  const idle =
    request.action === "turn"
      ? idleDeadline((failure) => {
          error = failure;
          cancel(true);
        })
      : null;
  const controls = new SteeringControls((message) => {
    if (p.stdin.destroyed || p.stdin.writableEnded)
      throw new Error("Runtime closed");
    p.stdin.write(JSON.stringify(message) + "\n");
  });
  const handle = {
    process: p,
    cancel,
    controls,
    provider: request.provider,
    controlId: request.input?.controlId,
    ready: false,
  };
  active.set(key, handle);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  p.stderr.resume(); // Docker/runtime diagnostics can contain credential material. Do not relay them.
  p.stdin.on("error", () => {});
  lines(
    p.stdout,
    (m) => {
      if (m.steeringReady) handle.ready = true;
      if (m.done || m.error) handle.ready = false;
      if (m.steeringResult) {
        controls.receive(m.steeringResult);
        return;
      }
      if (m.chunk || m.done || m.result) idle?.progress();
      if (m.result) result = m.result;
      if (m.error)
        error =
          m.code === "runtime_failure"
            ? new RuntimeFailure(
                diagnosticText(m.error),
                runtimeFailureFacts(m.diagnostic),
              )
            : new Error(m.error);
      if (m.login && deadline) {
        deadline.ready();
        m.expiresAt = deadline.expiresAt;
      }
      onEvent(m);
    },
    (e) => {
      error = e;
      cancel();
    },
  );
  p.stdin.write(JSON.stringify(request) + "\n");
  if (request.action !== "login" && !handle.controlId) p.stdin.end();
  try {
    const code = await new Promise((resolve, reject) => {
      p.once("error", reject);
      p.once("close", (c, signal) => {
        exitSignal = signal;
        closed = true;
        resolve(c);
      });
    });
    if (
      error ||
      code !== 0 ||
      signal?.aborted ||
      (request.action !== "turn" && !result)
    )
      throw (
        error ||
        new RuntimeFailure(
          `The runtime ${hostMode ? "process" : "container"} stopped (${exitSignal ? `signal ${exitSignal}` : `exit code ${code}`}) before returning a complete response.${code === 137 || exitSignal === "SIGKILL" ? " It was killed; check the runtime host's memory and container logs." : ""}`,
          { phase: "process", exitCode: code, signal: exitSignal },
        )
      );
    return result;
  } finally {
    controls.close();
    clearTimeout(timer);
    idle?.clear();
    deadline?.clear();
    signal?.removeEventListener("abort", cancel);
    if (active.get(key) === handle) active.delete(key);
    if (!closed) p.kill("SIGTERM");
    if (!hostMode) await remove(name);
  }
}
function serial(key, fn) {
  const generation = generations.get(key) || 0;
  const previous = pending.get(key) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => {
      if ((generations.get(key) || 0) !== generation)
        throw new Error("Cancelled");
      return fn();
    });
  const tail = task.catch(() => {});
  pending.set(key, tail);
  void tail.then(() => {
    if (pending.get(key) === tail) pending.delete(key);
  });
  return task;
}
async function body(req) {
  let data = "";
  for await (const b of req) {
    data += b;
    if (data.length > 1_000_000) throw new Error("Request too large");
  }
  return JSON.parse(data);
}
const json = (res, data, code = 200) => {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
};
const handleMcp = mcpHandler(
  prefix,
  process.env.LOOP_MCP_IMAGE || "loop-mcp:0.1",
  body,
  json,
  remove,
);
const server = createServer(async (req, res) => {
  if (!authorized(req.headers.authorization)) {
    json(res, { error: "Unauthorized" }, 401);
    return;
  }
  if (req.url === "/health" && req.method === "GET") {
    json(res, {
      ok: true,
      kind: hostMode ? "native-host" : "broker",
      nativeTools: true,
    });
    return;
  }
  if (
    !req.url?.startsWith("/mcp") &&
    (req.url !== "/runtime" || req.method !== "POST")
  ) {
    json(res, { error: "Not found" }, 404);
    return;
  }
  try {
    if (hostMode && req.url?.startsWith("/mcp")) {
      json(
        res,
        { error: "Manage native MCPs in Codex or Claude Code on this host." },
        400,
      );
      return;
    }
    if (!hostMode && (await handleMcp(req, res))) return;
    const data = await body(req),
      { key, provider, action } = data;
    if (!/^[a-f0-9]{64}$/.test(key) || !["codex", "claude"].includes(provider))
      throw new Error("Invalid runtime");
    if (action === "steer") {
      const target = active.get(key);
      if (
        !target?.ready ||
        target.provider !== provider ||
        typeof data.controlId !== "string" ||
        target.controlId !== data.controlId
      ) {
        json(res, { error: "The selected turn is no longer active." }, 409);
        return;
      }
      if (
        typeof data.id !== "string" ||
        !data.id ||
        data.id.length > 150 ||
        typeof data.text !== "string" ||
        !data.text.trim() ||
        data.text.length > 500000
      )
        throw new Error("Invalid steering input");
      json(res, await target.controls.send(data.id, data.text));
      return;
    }
    // Pair the host user's existing login; never start login or sign out the
    // shared Codex/Claude installation on behalf of a Loop connection.
    if (hostMode && ["login", "status"].includes(action)) {
      if (pending.has(key)) {
        json(res, { state: "busy" });
        return;
      }
      json(
        res,
        await serial(key, () =>
          execute(key, { provider, action: "status" }, () => {}),
        ),
      );
      return;
    }
    if (hostMode && action === "code") {
      json(
        res,
        {
          error: "Sign in using the official CLI on the host, then reconnect.",
        },
        400,
      );
      return;
    }
    if (hostMode && action === "logout") {
      generations.set(key, (generations.get(key) || 0) + 1);
      active.get(key)?.cancel();
      json(res, { ok: true });
      return;
    }
    if (action === "login") {
      if (pending.has(key)) {
        json(
          res,
          {
            error: "This account is busy. Finish or cancel current work first.",
          },
          409,
        );
        return;
      }
      const login = {
        state: "starting",
        expiresAt: Date.now() + LOGIN_START_MS,
      };
      logins.set(key, login);
      void serial(key, () =>
        execute(key, { provider, action }, (m) => {
          if (m.login && login.state === "starting") {
            login.state = "waiting";
            login.login = m.login;
            login.expiresAt = m.expiresAt;
          }
        }),
      ).then(
        (result) => {
          if (login.state === "cancelled") return;
          login.state = "completed";
          login.result = result;
          delete login.login;
        },
        (error) => {
          if (login.state === "cancelled") return;
          login.state = "failed";
          login.error =
            error instanceof LoginTimeoutError
              ? error.message
              : "Sign-in failed. Try sign-in again.";
          delete login.login;
        },
      );
      json(res, login);
      return;
    }
    if (action === "code") {
      const l = logins.get(key),
        a = active.get(key);
      if (
        !l?.login?.acceptsCode ||
        l.state !== "waiting" ||
        Date.now() > l.expiresAt ||
        !a
      )
        throw new Error("No active sign-in");
      if (
        typeof data.code !== "string" ||
        !data.code.trim() ||
        data.code.length > 4096 ||
        /[\r\n]/.test(data.code)
      )
        throw new Error("Invalid sign-in code");
      a.process.stdin.write(JSON.stringify({ code: data.code.trim() }) + "\n");
      json(res, { ok: true });
      return;
    }
    if (action === "cancel") {
      const l = logins.get(key);
      if (l) {
        l.state = "cancelled";
        delete l.login;
      }
      active.get(key)?.cancel();
      json(res, { ok: true });
      return;
    }
    if (action === "status") {
      const l = logins.get(key);
      if (l && ["starting", "waiting"].includes(l.state)) {
        json(res, l);
        return;
      }
      if (l?.state === "completed") {
        logins.delete(key);
        json(res, { state: "completed", ...l.result });
        return;
      }
      if (l?.state === "failed") {
        logins.delete(key);
        json(res, l);
        return;
      }
      if (pending.has(key)) {
        json(res, { state: "busy" });
        return;
      }
      const result = await serial(key, () =>
        execute(key, { provider, action }, () => {}),
      );
      json(res, result);
      return;
    }
    if (action === "logout") {
      generations.set(key, (generations.get(key) || 0) + 1);
      logins.delete(key);
      active.get(key)?.cancel();
      await serial(key, () => execute(key, { provider, action }, () => {}));
      json(res, { ok: true });
      return;
    }
    if (action === "read-file") {
      const result = await serial(key, () =>
        execute(
          key,
          {
            // File reads are provider-independent. Use the one-shot runtime
            // path even when Codex turns use a persistent worker.
            provider: "file",
            action,
            workspaceKey: data.workspaceKey,
            path: data.path,
            offset: data.offset,
            version: data.version,
          },
          () => {},
        ),
      );
      json(res, result);
      return;
    }
    if (action === "capabilities") {
      if (pending.has(key)) {
        json(
          res,
          {
            error:
              "This runtime is busy. Refresh commands when its current run finishes.",
          },
          409,
        );
        return;
      }
      json(
        res,
        await serial(key, () =>
          execute(
            key,
            { provider, action, workspaceKey: data.workspaceKey },
            () => {},
          ),
        ),
      );
      return;
    }
    if (
      action !== "turn" ||
      !data.input ||
      typeof data.input.model !== "string" ||
      data.input.model.length > 200 ||
      !Array.isArray(data.input.messages)
    )
      throw new Error("Invalid action");
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    });
    res.flushHeaders();
    // Keep the transport alive while queued or inside a quiet native tool.
    // Empty NDJSON lines never become agent output or traces.
    const heartbeat = setInterval(() => res.write("\n"), 15000);
    res.once("close", () => clearInterval(heartbeat));
    try {
      await serial(key, () => {
        if (controller.signal.aborted) throw new Error("Cancelled");
        return execute(
          key,
          {
            provider,
            action,
            input: data.input,
            githubToken: data.githubToken,
          },
          (m) => res.write(JSON.stringify(m) + "\n"),
          controller.signal,
        );
      });
      res.end();
    } finally {
      clearInterval(heartbeat);
    }
  } catch (error) {
    if (res.headersSent) {
      res.end(
        JSON.stringify({
          ...(error instanceof IdleTimeoutError
            ? { code: "idle_timeout" }
            : error instanceof RuntimeFailure
              ? {
                  code: "runtime_failure",
                  diagnostic: runtimeFailureFacts(error.details),
                }
              : {}),
          error:
            error instanceof IdleTimeoutError || error instanceof RuntimeFailure
              ? error.message
              : "Subscription runtime stopped. Check sign-in, model access and allowance. No API fallback occurred.",
        }) + "\n",
      );
    } else
      json(
        res,
        {
          error:
            "Subscription runtime unavailable or request invalid. Check the runtime service and sign in again.",
        },
        422,
      );
  }
});
// Remove only this deployment's orphaned operation containers after a broker restart.
if (!hostMode) {
  const orphan = docker([
    "ps",
    "-aq",
    "--filter",
    "label=loop.runtime=" + prefix,
  ]);
  let ids = "";
  orphan.stdout.on("data", (b) => {
    ids += b;
  });
  orphan.stderr.resume();
  await new Promise((resolve) => {
    orphan.once("error", resolve);
    orphan.once("close", resolve);
  });
  for (const id of ids
    .trim()
    .split(/\s+/)
    .filter((id) => /^[a-f0-9]{12,64}$/.test(id)))
    await remove(id);
}
server.listen(
  Number(process.env.PORT || (hostMode ? 3101 : 3100)),
  process.env.LOOP_RUNTIME_BIND || (hostMode ? "127.0.0.1" : "0.0.0.0"),
);
process.on("SIGTERM", () => {
  for (const a of active.values()) a.cancel();
  server.close();
});
