import { containerArgs } from "./container.mjs";
// Private control plane. Only this service has the Docker socket, never model containers.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lines } from "./protocol.mjs";
const token = process.env.LOOP_RUNTIME_TOKEN;
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
  const p = docker(containerArgs(prefix, key, image, name));
  let result,
    error,
    closed = false;
  const cancel = () => {
    p.kill("SIGTERM");
    void remove(name);
  };
  const timer = setTimeout(
    cancel,
    request.action === "login" ? 10 * 60 * 1000 : 30 * 60 * 1000,
  );
  const handle = { process: p, cancel };
  active.set(key, handle);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  p.stderr.resume(); // Docker/runtime diagnostics can contain credential material. Do not relay them.
  p.stdin.on("error", () => {});
  lines(
    p.stdout,
    (m) => {
      if (m.result) result = m.result;
      if (m.error) error = new Error(m.error);
      onEvent(m);
    },
    (e) => {
      error = e;
      cancel();
    },
  );
  p.stdin.write(JSON.stringify(request) + "\n");
  if (request.action !== "login") p.stdin.end();
  try {
    const code = await new Promise((resolve, reject) => {
      p.once("error", reject);
      p.once("close", (c) => {
        closed = true;
        resolve(c);
      });
    });
    if (error || code !== 0 || signal?.aborted)
      throw (
        error ||
        new Error(
          "Subscription runtime stopped. Reconnect or check your allowance; no API fallback occurred.",
        )
      );
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (active.get(key) === handle) active.delete(key);
    if (!closed) p.kill("SIGTERM");
    await remove(name);
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
const server = createServer(async (req, res) => {
  if (!authorized(req.headers.authorization)) {
    json(res, { error: "Unauthorized" }, 401);
    return;
  }
  if (req.url === "/health" && req.method === "GET") {
    json(res, { ok: true });
    return;
  }
  if (req.url !== "/runtime" || req.method !== "POST") {
    json(res, { error: "Not found" }, 404);
    return;
  }
  try {
    const data = await body(req),
      { key, provider, action } = data;
    if (!/^[a-f0-9]{64}$/.test(key) || !["codex", "claude"].includes(provider))
      throw new Error("Invalid runtime");
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
      const login = { state: "starting", expiresAt: Date.now() + 600000 };
      logins.set(key, login);
      void serial(key, () =>
        execute(key, { provider, action }, (m) => {
          if (m.login) {
            login.state = "waiting";
            login.login = m.login;
          }
        }),
      ).then(
        (result) => {
          login.state = "completed";
          login.result = result;
        },
        () => {
          login.state = "failed";
          login.error = "Sign-in expired or failed. Start a new sign-in.";
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
    await serial(key, () => {
      if (controller.signal.aborted) throw new Error("Cancelled");
      return execute(
        key,
        { provider, action, input: data.input },
        (m) => res.write(JSON.stringify(m) + "\n"),
        controller.signal,
      );
    });
    res.end();
  } catch {
    if (res.headersSent) {
      res.end(
        JSON.stringify({
          error:
            "Subscription runtime stopped. Check sign-in, model access and allowance. No API fallback occurred.",
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
server.listen(Number(process.env.PORT || 3100), "0.0.0.0");
process.on("SIGTERM", () => {
  for (const a of active.values()) a.cancel();
  server.close();
});
