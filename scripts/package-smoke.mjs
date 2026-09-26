import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  chmod,
  copyFile,
  rm,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
const exec = promisify(execFile),
  base = await mkdtemp(join(tmpdir(), "loop-package-"));
let child, ws, tarball;
try {
  await exec("npm", ["run", "build"], { maxBuffer: 4_000_000 });
  const { stdout } = await exec("npm", ["pack", "--ignore-scripts", "--json"], {
    maxBuffer: 1000000,
  });
  tarball = resolve(JSON.parse(stdout)[0].filename);
  const target = join(base, "clean install é"),
    project = join(base, "project with spaces 漢字");
  await mkdir(target);
  await mkdir(project);
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      target,
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { maxBuffer: 1000000, timeout: 240000 },
  );
  const bin = join(target, "node_modules", ".bin", "loop"),
    env = {
      ...process.env,
      LOOP_HOME: join(base, "loop-state"),
      LOOP_TEST_HARNESS: "codex",
    };
  const fixture = join(base, "fixture-harness");
  await copyFile("test/harness.mjs", fixture);
  await chmod(fixture, 0o755);
  assert.equal(
    (await exec(bin, ["--version"], { env })).stdout.trim(),
    JSON.parse(await readFile("package.json", "utf8")).version,
  );
  const launch = async () => {
    child = spawn(
      bin,
      [
        "codex",
        "--executable",
        fixture,
        "--project",
        project,
        "--billing",
        "existing",
        "--local-only",
      ],
      { env, stdio: "pipe" },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (errors += b));
    const end = Date.now() + 20000,
      pattern = /http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/;
    while (!output.match(pattern)) {
      if (Date.now() > end || child.exitCode !== null)
        throw new Error("Packed CLI did not start: " + errors);
      await new Promise((r) => setTimeout(r, 30));
    }
    return new URL(output.match(pattern)[0]);
  };
  let url = await launch();
  const html = await fetch(url.origin).then(r => r.text());
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(m => m[1]);
  assert(assets.some(p => p.endsWith(".js")) && assets.some(p => p.endsWith(".css")));
  for (const path of [
    "/",
    ...assets,
    "/manifest.webmanifest",
    "/icon-192.png",
    "/icon-512.png",
    "/apple-touch-icon.png",
    "/sw.js",
  ])
    assert.equal((await fetch(url.origin + path)).status, 200, path);
  const pair = async () => {
    const r = await fetch(url.origin + "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url.origin },
      body: JSON.stringify({
        secret: new URLSearchParams(url.hash.slice(1)).get("pair"),
        name: "Package fixture",
      }),
    });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie").split(";")[0],
      { csrf } = await fetch(url.origin + "/session", {
        headers: { Cookie: cookie },
      }).then((r) => r.json());
    return {
      cookie,
      api: async (path, body) => {
        const response = await fetch(url.origin + "/api" + path, {
          method: body ? "POST" : "GET",
          headers: {
            Cookie: cookie,
            Origin: url.origin,
            "x-loop-csrf": csrf,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await response.json();
        assert(response.ok, JSON.stringify(data));
        return data;
      },
    };
  };
  let { cookie, api } = await pair();
  const agent = await api("/agents", {
    name: "packed-agent",
    connectionId: "native-codex",
    model: "native-default",
  });
  const run = await api("/runs", {
    agentId: agent.id,
    input: "packaged workspace task",
    idempotencyKey: crypto.randomUUID(),
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Packed WS journey timed out")),
      10000,
    );
    ws = new WebSocket(url.origin.replace("http:", "ws:") + "/ws", {
      headers: { Origin: url.origin, Cookie: cookie },
    });
    ws.on("error", reject);
    ws.on("message", async (b) => {
      const m = JSON.parse(b.toString());
      if (
        m.type === "events" &&
        m.events.some((e) => e.run_id === run.id && e.type === "completed")
      ) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const status = JSON.parse(
    (await exec(bin, ["status", "--json"], { env })).stdout,
  );
  assert.equal(status.workspace, true);
  assert.equal(status.agents, 1);
  assert.equal(status.state, "ready");
  assert(!JSON.stringify(status).includes(cookie.split("=")[1]));
  const repeated = await exec(
    bin,
    [
      "codex",
      "--executable",
      fixture,
      "--project",
      project,
      "--billing",
      "existing",
      "--local-only",
    ],
    { env },
  );
  assert.match(repeated.stdout, /existing workspace/);
  assert(!repeated.stdout.includes("#pair="));
  const stop = async () => {
    await exec(bin, ["stop"], { env });
    await new Promise((r) =>
      child.exitCode !== null ? r() : child.once("exit", r),
    );
  };
  ws.close();
  await stop();
  url = await launch();
  ({ cookie, api } = await pair());
  const restored = await api("/bootstrap");
  assert(restored.agents.some((a) => a.id === agent.id));
  const history = await api("/conversations/" + run.conversation_id);
  assert(history.messages.some((m) => m.content === "Fixture done"));
  await stop();
  // The very same installed distribution runs the retained server too.
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const serverOrigin = "http://127.0.0.1:" + port;
  child = spawn(bin, ["server"], {
    cwd: target,
    env: { ...env, PORT: String(port), LOOP_URL: serverOrigin, LOOP_DATA_DIR: join(base, "server-state"),
      LOOP_AUTH_MODE: "single-user", BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErrors = "";
  child.stdout.resume();
  child.stderr.on("data", b => serverErrors += b);
  const deadline = Date.now() + 20000;
  while (!(await fetch(serverOrigin + "/api/health").then(r => r.ok).catch(() => false))) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error("Packed server did not start: " + serverErrors);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await fetch(serverOrigin + "/api/capabilities").then(r => r.json())).profile, "server");
  assert.equal((await fetch(serverOrigin + "/api/bootstrap")).status, 200);
  const serverHtml = await fetch(serverOrigin).then(r => r.text());
  assert.match(serverHtml, /<div id="root">/);
  for (const asset of assets) assert.equal((await fetch(serverOrigin + asset)).status, 200);
  child.kill("SIGTERM");
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
  await exec(bin, ["uninstall"], { env });
  assert(
    (await readFile(join(env.LOOP_HOME, "workspace", "loop.db"))).length > 0,
  );
  console.log(
    "Clean tarball install: original UI assets, pairing, native workspace run, duplicate CLI, restart persistence, stop, retained data and server profile passed. Fixture only.",
  );
} finally {
  ws?.terminate();
  child?.kill("SIGKILL");
  await rm(base, { recursive: true, force: true });
  if (tarball) await rm(tarball, { force: true });
}
