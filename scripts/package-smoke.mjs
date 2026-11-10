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
import { request } from "node:http";
import { existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { markDisposableFixture } from "./helpers/disposable-fixture.mjs";
const exec = promisify(execFile),
  base = await mkdtemp(join(tmpdir(), "loop-package-"));
markDisposableFixture(base);
let child, ws, tarball, bin, env;
try {
  await exec("npm", ["run", "build"], { maxBuffer: 4_000_000 });
  const { stdout } = await exec("npm", ["pack", "--ignore-scripts", "--json"], {
    maxBuffer: 1000000,
  });
  const packedFiles = JSON.parse(stdout)[0];
  assert(packedFiles.files.some(({ path }) => path === "dist/web/index.html"));
  assert(
    !packedFiles.files.some(({ path }) => path.startsWith("dist/client/")),
    "the package contains one UI tree",
  );
  tarball = resolve(packedFiles.filename);
  const target = join(base, "clean install é"),
    project = join(base, "project with spaces 漢字");
  await mkdir(target);
  await mkdir(project);
  // Native agents execute in isolated checkouts of committed project files.
  await exec("git", ["init", project]);
  writeFileSync(join(project, "tracked.txt"), "Package fixture\n");
  await exec("git", ["-C", project, "add", "tracked.txt"]);
  await exec("git", [
    "-C",
    project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "initial",
  ]);
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
  // Exercise the installed JavaScript module graph without tsx: source-level
  // adapter fixtures cannot detect missing compiled runtime dependencies.
  await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const { Acp } = await import("@j-asefa/loop/dist/adapters/acp.js"); if (typeof Acp !== "function") throw new Error("Missing packaged ACP adapter");',
    ],
    { cwd: target, timeout: 10000 },
  );
  const identity = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'const { runningBuild, publicBuild } = await import("@j-asefa/loop/dist/shared/build.js"); console.log(JSON.stringify(publicBuild(runningBuild)));',
        ],
        { cwd: target, timeout: 10000 },
      )
    ).stdout,
  );
  assert.equal(
    identity.id,
    JSON.parse(await readFile("dist/build-id.json", "utf8")).id,
  );
  assert.notEqual(identity.id, "development");
  const stamp = JSON.parse(await readFile("dist/build-id.json", "utf8"));
  assert.equal(
    stamp.release,
    JSON.parse(await readFile("package.json", "utf8")).version,
  );
  assert(
    (await readFile("dist/web/sw.js", "utf8")).includes(
      JSON.stringify(`loop-shell-${identity.id}`),
    ),
  );
  bin = join(target, "node_modules", ".bin", "loop");
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
  // `loop codex` shows the pairing code, then returns while the workspace keeps
  // running in the background.
  const launch = async () => {
    const { stdout } = await exec(
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
      { env, timeout: 30000 },
    );
    const match = stdout.match(
      /http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/,
    );
    if (!match) throw new Error("Packed CLI did not show pairing: " + stdout);
    return new URL(match[0]);
  };
  let url = await launch();
  const html = await fetch(url.origin).then((r) => r.text());
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(
    (m) => m[1],
  );
  assert(
    assets.some((p) => p.endsWith(".js")) &&
      assets.some((p) => p.endsWith(".css")),
  );
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
  const companionBuild = await api("/build");
  assert.deepEqual(companionBuild.serving, identity);
  assert.deepEqual(companionBuild.processes.map((p) => p.role).sort(), [
    "api",
    "worker",
  ]);
  for (const process of companionBuild.processes)
    assert.deepEqual(process.build, identity);
  const agent = await api("/agents", {
    name: "packed-agent",
    connectionId: "native-codex",
    model: "native-default",
  });
  const frames = [];
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Packed WS reset timed out")),
      10000,
    );
    ws = new WebSocket(url.origin.replace("http:", "ws:") + "/ws?v=3", {
      headers: { Origin: url.origin, Cookie: cookie },
    });
    ws.on("error", reject);
    ws.on("message", (b) => frames.push(JSON.parse(b.toString())));
    ws.once("message", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  assert.equal(frames[0].v, 3);
  assert.equal(frames[0].type, "reset");
  assert.equal(typeof frames[0].serverNow, "number");
  assert(Object.hasOwn(frames[0], "nextDeadline"));
  // Subscribe before dispatch so even an immediate completion is observed.
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
    const completed = () => {
      if (
        frames.some(
          (frame) =>
            frame.type === "events" &&
            frame.events.some(
              ({ event }) =>
                event.type === "completed" &&
                event.scope.kind === "run" &&
                event.scope.id === run.id,
            ),
        )
      ) {
        clearTimeout(timeout);
        ws.off("message", completed);
        resolve();
      }
    };
    ws.on("message", completed);
    completed();
  });
  const status = JSON.parse(
    (await exec(bin, ["status", "--json"], { env })).stdout,
  );
  assert.equal(status.workspace, true);
  assert.equal(status.agents, 1);
  assert.equal(status.state, "ready");
  assert.deepEqual(status.buildIdentity, identity);
  assert.equal(status.build, identity.id);
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
  // Waits for the background workspace process to exit.
  const stop = () => exec(bin, ["stop"], { env });
  ws.close();
  await stop();
  url = await launch();
  ({ cookie, api } = await pair());
  const restored = await api("/bootstrap");
  assert(restored.agents.some((a) => a.id === agent.id));
  const history = await api("/conversations/" + run.conversation_id);
  assert(history.messages.some((m) => m.content === "Fixture done"));
  await stop();
  // Loop ships only the companion: the packaged CLI has no server command.
  await assert.rejects(exec(bin, ["server"], { env }), /Unknown command/);
  await exec(bin, ["uninstall"], { env });
  assert(
    (await readFile(join(env.LOOP_HOME, "workspace", "loop.db"))).length > 0,
  );
  // The upgrade fixture installs its own package; release this first install
  // before npm temporarily keeps both old and new upgrade dependency trees.
  await rm(target, { recursive: true, force: true });
  await upgradeBehindConnection();
  console.log(
    "Clean tarball install: original UI assets, pairing, native workspace run, duplicate CLI, restart persistence, stop, retained data, no server command, and loop upgrade between packed builds behind one connection service passed. Fixture tunnel only.",
  );
} finally {
  ws?.terminate();
  child?.kill("SIGKILL");
  if (bin) await exec(bin, ["stop"], { env }).catch(() => {});
  await rm(base, { recursive: true, force: true });
  if (tarball) await rm(tarball, { force: true });
}

/**
 * `loop upgrade` from one packed build to a distinguishable second one, both
 * installed globally into a private prefix, with the fixture tunnel helper.
 * The connection service, its cloudflared and the address must survive; the
 * browser cookie must keep working; the new assets and release must serve.
 */
async function upgradeBehindConnection() {
  const prefix = join(base, "global prefix");
  const state = join(base, "upgrade-state");
  const work = join(base, "upgrade-project");
  await mkdir(prefix);
  await mkdir(work);
  const upgradeEnv = {
    ...process.env,
    npm_config_prefix: prefix,
    LOOP_HOME: state,
    LOOP_TEST_HARNESS: "codex",
    LOOP_TEST_CLOUDFLARED: resolve("test/fixtures/fake-cloudflared.mjs"),
  };
  await chmod(upgradeEnv.LOOP_TEST_CLOUDFLARED, 0o755);
  // Build B: same code, new version and an asset marker the browser can see.
  const unpacked = join(base, "build-b");
  await mkdir(unpacked);
  await exec("tar", ["-xzf", tarball, "-C", unpacked]);
  const pkg = join(unpacked, "package");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const nextVersion = manifest.version + "-upgrade.1";
  manifest.version = nextVersion;
  writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(pkg, "dist", "support", "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  const index = join(pkg, "dist", "web", "index.html");
  writeFileSync(
    index,
    readFileSync(index, "utf8").replace(
      "</head>",
      "<!-- loop-build-b --></head>",
    ),
  );
  const packed = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", pkg, "--ignore-scripts", "--json", "--pack-destination", base],
        { maxBuffer: 1000000 },
      )
    ).stdout,
  );
  const tarballB = join(base, packed[0].filename);
  await exec(
    "npm",
    ["install", "-g", "--omit=optional", "--no-audit", "--no-fund", tarball],
    {
      env: upgradeEnv,
      maxBuffer: 1000000,
      timeout: 240000,
    },
  );
  const loop = (...args) =>
    exec(join(prefix, "bin", "loop"), args, {
      env: upgradeEnv,
      timeout: 300000,
      maxBuffer: 4000000,
    });
  const fixture = join(base, "fixture-harness");
  const started = await loop(
    "codex",
    "--executable",
    fixture,
    "--project",
    work,
    "--billing",
    "existing",
  );
  const { fleetDeviceFromLink } =
    await import("../dist/shared/fleet-pairing.js");
  const pairUrl = started.stdout.match(
    /https:\/\/[^\s]+\/#(?:pair|fleet)=[\w-]+/,
  )[0];
  const code = fleetDeviceFromLink(pairUrl, new URL(pairUrl).origin).secret;
  const status = async () =>
    JSON.parse((await loop("status", "--json")).stdout);
  const before = await status();
  const relay = new URL(before.connection.service.relay);
  let cookie = "";
  const send = (method, path, body) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: relay.hostname,
          port: Number(relay.port),
          method,
          path,
          headers: {
            host: new URL(before.url).host,
            origin: before.url,
            ...(cookie ? { cookie } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
          },
        },
        (res) => {
          let out = "";
          res.on("data", (b) => (out += b));
          res.on("end", () => {
            if (res.headers["set-cookie"])
              cookie = res.headers["set-cookie"][0].split(";")[0];
            resolve({ status: res.statusCode, body: out });
          });
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  assert.equal(
    (await send("POST", "/pair", { secret: code, name: "Upgrade fixture" }))
      .status,
    200,
  );
  assert.equal((await send("GET", "/api/bootstrap")).status, 200);
  const devices = (await send("GET", "/api/workspace/devices")).body;
  assert.doesNotMatch((await send("GET", "/")).body, /loop-build-b/);
  const service = join(state, "connection", "bin");
  const artifacts = readdirSync(service);
  assert.equal(artifacts.length, 1, "the service runs from an immutable copy");

  // A failed install leaves the running application alone.
  await assert.rejects(loop("upgrade", "--from", join(base, "missing.tgz")));
  assert.equal((await status()).pid, before.pid);

  const upgraded = await loop("upgrade", "--from", tarballB);
  assert.match(
    upgraded.stdout,
    new RegExp(
      `Upgraded from Loop ${manifest.version.replace("-upgrade.1", "")} to ${nextVersion.replace(/\./g, "\\.")}`,
    ),
  );
  assert.match(upgraded.stdout, /Same address/);
  const after = await status();
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.release, nextVersion, "the new build is serving");
  assert.equal(after.url, before.url);
  assert.equal(after.connection.service.pid, before.connection.service.pid);
  assert.equal(
    after.connection.service.tunnel.pid,
    before.connection.service.tunnel.pid,
  );
  assert.equal(
    after.harnesses[0].name,
    "codex",
    "the saved runtime was restored, not Pi",
  );
  assert.equal(after.harnesses[0].billing.mode, "existing");
  assert.equal(after.project, before.project);
  assert.equal(
    (await send("GET", "/api/bootstrap")).status,
    200,
    "the same cookie still works",
  );
  assert.equal((await send("GET", "/api/workspace/devices")).body, devices);
  assert.match(
    (await send("GET", "/")).body,
    /loop-build-b/,
    "new assets at the old address",
  );
  assert.deepEqual(
    readdirSync(service),
    artifacts,
    "the running service's file was untouched",
  );
  assert(existsSync(join(service, artifacts[0])));
  await loop("stop");
  assert.equal((await status()).state, "stopped");
  assert.equal((await status()).connection.state, "stopped");
}
