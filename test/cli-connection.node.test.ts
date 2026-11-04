import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer, request } from "node:http";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { alive } from "../src/daemon.js";
import { identity, pidNamespace } from "../src/lifecycle.js";
import { ensureRunDir } from "../src/connection.js";
import { killFixtureProcess, until } from "./helpers.js";
import { gitProject } from "./git-project.js";
import { fleetDeviceFromLink } from "../src/shared/fleet-pairing.js";

const exec = promisify(execFile);
const FAKE = resolve("test/fixtures/fake-cloudflared.mjs");

async function workspace(extraEnv: Record<string, string> = {}) {
  await mkdir(".tmp", { recursive: true });
  await chmod(FAKE, 0o755);
  const base = await mkdtemp(join(resolve(".tmp"), "loop-cli-connection-"));
  const project = join(base, "project");
  await mkdir(project);
  gitProject(project);
  const fixture = join(base, "codex");
  await copyFile(resolve("test/harness.mjs"), fixture);
  await chmod(fixture, 0o755);
  const tunnels = join(base, "tunnels.log");
  const audit = join(base, "prompts.log");
  const env = {
    ...process.env,
    LOOP_HOME: join(base, "state"),
    LOOP_TEST_HARNESS: "codex",
    LOOP_TEST_CLOUDFLARED: FAKE,
    LOOP_TEST_TUNNEL_LOG: tunnels,
    LOOP_TEST_AUDIT: audit,
    LOOP_TEST_STOP_GRACE_MS: "1000",
    ...extraEnv,
  };
  const loop = (args: string[], timeout = 60000) =>
    exec(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env,
      timeout,
    });
  const harness = [
    "codex",
    "--executable",
    fixture,
    "--project",
    project,
    "--billing",
    "existing",
  ];
  const status = async () =>
    JSON.parse((await loop(["status", "--json"])).stdout);
  const tunnelPids = () =>
    existsSync(tunnels)
      ? readFileSync(tunnels, "utf8")
          .trim()
          .split("\n")
          .map((l) => Number(l.split(" ")[0]))
      : [];
  const pids = new Set<number>();
  const cleanup = async () => {
    await loop(["stop"]).catch(() => {});
    for (const pid of [...pids, ...tunnelPids()])
      if (alive(pid)) killFixtureProcess(pid);
    await rm(base, { recursive: true, force: true });
  };
  return {
    base,
    env,
    loop,
    harness,
    status,
    tunnelPids,
    pids,
    cleanup,
    audit,
    connection: join(env.LOOP_HOME, "connection"),
  };
}

/** A browser as cloudflared delivers it: public Host, cookie and Origin to the relay. */
function browser(relay: string, origin: string) {
  let cookie = "";
  let csrf = "";
  const send = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; headers: any; json: any }>(
      (resolve, reject) => {
        const url = new URL(relay);
        const req = request(
          {
            host: url.hostname,
            port: Number(url.port),
            method,
            path,
            headers: {
              host: new URL(origin).host,
              origin,
              ...(cookie ? { cookie } : {}),
              ...(csrf ? { "x-loop-csrf": csrf } : {}),
              ...(body ? { "content-type": "application/json" } : {}),
            },
          },
          (res) => {
            let out = "";
            res.on("data", (b) => (out += b));
            res.on("end", () => {
              const set = res.headers["set-cookie"]?.[0];
              if (set) cookie = set.split(";")[0];
              let json: any;
              try {
                json = JSON.parse(out);
              } catch {
                json = out;
              }
              resolve({ status: res.statusCode!, headers: res.headers, json });
            });
          },
        );
        req.on("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      },
    );
  return {
    send,
    async pair(code: string) {
      const paired = await send("POST", "/pair", {
        secret: code,
        name: "Fixture phone",
      });
      assert.equal(paired.status, 200);
      csrf = (await send("GET", "/session")).json.csrf;
    },
    get cookie() {
      return cookie;
    },
  };
}
const pairCode = (stdout: string) => {
  const link = stdout.match(/https?:\/\/[^\s]+\/#(?:pair|fleet)=[\w-]+/)![0];
  return fleetDeviceFromLink(link, new URL(link).origin).secret;
};

test("restart replaces only the application: same service, cloudflared, address, device and settings", async () => {
  const w = await workspace();
  try {
    const started = await w.loop(w.harness);
    const before = await w.status();
    w.pids.add(before.pid);
    const service = before.connection.service;
    assert.equal(before.state, "ready");
    assert.equal(before.connection.mode, "quick");
    assert.equal(before.connection.registered, true);
    assert.equal(service.state, "running");
    assert.equal(service.tunnel.state, "ready");
    assert.equal(service.url, before.url);
    assert.match(
      before.url,
      /^https:\/\/loop-fixture-\d+\.trycloudflare\.com$/,
    );
    assert.equal(w.tunnelPids().length, 1);
    assert.equal(service.tunnel.pid, w.tunnelPids()[0]);
    assert.doesNotMatch(JSON.stringify(before), /token|control\.sock/);

    const phone = browser(service.relay, before.url);
    await phone.pair(pairCode(started.stdout));
    assert.equal((await phone.send("GET", "/api/bootstrap")).status, 200);
    const devices = (await phone.send("GET", "/api/workspace/devices")).json;
    assert.equal(devices.length, 1);

    const restarted = await w.loop(["restart"]);
    assert.match(restarted.stdout, /Same address: https:\/\/loop-fixture-/);
    assert.doesNotMatch(
      restarted.stdout,
      /#(?:pair|fleet)=/,
      "no new pairing after an application restart",
    );
    const after = await w.status();
    w.pids.add(after.pid);
    assert.notEqual(after.pid, before.pid);
    assert(!alive(before.pid));
    assert.equal(after.url, before.url);
    assert.equal(after.connection.service.pid, service.pid);
    assert.equal(after.connection.service.tunnel.pid, service.tunnel.pid);
    assert.equal(after.connection.generation, before.connection.generation + 1);
    assert.equal(w.tunnelPids().length, 1, "cloudflared was never restarted");
    // The saved launch was repeated: same harness, billing and project.
    assert.equal(after.harnesses[0].name, "codex");
    assert.equal(after.harnesses[0].billing.mode, "existing");
    assert.equal(after.project, before.project);
    const launch = JSON.parse(
      readFileSync(join(w.env.LOOP_HOME, "workspace", "launch.json"), "utf8"),
    );
    assert.deepEqual(launch.args.slice(0, 1), ["codex"]);

    // The same browser credential works; nothing re-paired.
    assert.equal((await phone.send("GET", "/api/bootstrap")).status, 200);
    assert.deepEqual(
      (await phone.send("GET", "/api/workspace/devices")).json,
      devices,
    );
    // Unpaired and revoked devices stay denied behind the relay.
    const stranger = browser(service.relay, before.url);
    assert.equal((await stranger.send("GET", "/api/bootstrap")).status, 401);
    assert.equal(
      (
        await stranger.send("POST", "/pair", {
          secret: pairCode(started.stdout),
        })
      ).status,
      403,
    );

    // While the application is down, the address stays and answers 503.
    process.kill(after.pid, "SIGKILL");
    await until(() => !alive(after.pid));
    const down = await phone.send("GET", "/api/bootstrap");
    assert.equal(down.status, 503);
    assert.equal(down.headers["x-loop-unavailable"], "restarting");
    const crashed = await w.status();
    assert.equal(crashed.state, "crashed");
    assert.equal(crashed.url, before.url);
    assert.equal(crashed.connection.state, "running");
    // Restart recovers it behind the same connection.
    await w.loop(["restart"]);
    const recovered = await w.status();
    w.pids.add(recovered.pid);
    assert.equal(recovered.url, before.url);
    assert.equal((await phone.send("GET", "/api/bootstrap")).status, 200);

    const stopped = JSON.parse((await w.loop(["stop", "--json"])).stdout);
    assert.equal(stopped.stopped, true);
    assert(!alive(recovered.pid));
    assert(!alive(service.pid));
    await until(() => !alive(service.tunnel.pid));
    assert.equal((await w.status()).state, "stopped");
    assert(!existsSync(join(w.connection, "connection.json")));
    await assert.rejects(w.loop(["stop"]), /No workspace is running/);
  } finally {
    await w.cleanup();
  }
});

test("restart refuses active runs, and a forced restart never resends interrupted work", async () => {
  const w = await workspace();
  try {
    const started = await w.loop(w.harness);
    const before = await w.status();
    w.pids.add(before.pid);
    const phone = browser(before.connection.service.relay, before.url);
    await phone.pair(pairCode(started.stdout));
    const agent = (
      await phone.send("POST", "/api/agents", {
        name: "held",
        connectionId: "native-codex",
        model: "native-default",
      })
    ).json;
    const run = (
      await phone.send("POST", "/api/runs", {
        agentId: agent.id,
        input: "approve",
        idempotencyKey: randomUUID(),
      })
    ).json;
    await until(
      () =>
        existsSync(w.audit) && readFileSync(w.audit, "utf8").includes("prompt"),
      20000,
    );
    let active = 0;
    for (let i = 0; i < 100 && !active; i++) {
      active = Number((await w.status()).activeRuns?.n ?? 0);
      if (!active) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(active, 1);
    await assert.rejects(
      w.loop(["restart"]),
      /1 run\(s\) are active.*--force/s,
    );
    assert.equal((await w.status()).pid, before.pid, "nothing was stopped");
    await w.loop(["restart", "--force"]);
    const after = await w.status();
    w.pids.add(after.pid);
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.url, before.url);
    // Give a replay every chance to happen, then prove it didn't.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(
      readFileSync(w.audit, "utf8")
        .split("\n")
        .filter((l) => l === "prompt").length,
      1,
    );
    const state = (await phone.send("GET", "/api/runs")).json.find(
      (item: any) => item.id === run.id,
    );
    assert(state, "the interrupted run remains recorded");
    assert.notEqual(state.state, "running");
  } finally {
    await w.cleanup();
  }
});

test("concurrent starts converge on one service and one cloudflared; a hung application is force-restarted alone", async () => {
  const w = await workspace();
  try {
    const results = await Promise.allSettled([
      w.loop(w.harness),
      w.loop(w.harness),
      w.loop(w.harness),
    ]);
    assert(results.some((r) => r.status === "fulfilled"));
    const status = await w.status();
    w.pids.add(status.pid);
    assert.equal(w.tunnelPids().length, 1, "exactly one cloudflared");
    const service = status.connection.service;

    // A frozen application: restart needs --force, then stops only it.
    process.kill(status.pid, "SIGSTOP");
    try {
      await assert.rejects(w.loop(["restart"]), /not responding.*--force/s);
      await w.loop(["restart", "--force"]);
    } finally {
      if (alive(status.pid)) process.kill(status.pid, "SIGCONT");
    }
    const after = await w.status();
    w.pids.add(after.pid);
    assert.notEqual(after.pid, status.pid);
    assert(!alive(status.pid));
    assert(
      alive(service.pid),
      "the connection service survived the forced stop",
    );
    assert.equal(after.connection.service.tunnel.pid, service.tunnel.pid);
    assert.equal(after.url, status.url);
  } finally {
    await w.cleanup();
  }
});

test("a stalled application is withdrawn, then returns by itself without re-pairing", async () => {
  const w = await workspace({ LOOP_TEST_LEASE_TIMEOUT_MS: "1500" });
  try {
    const started = await w.loop(w.harness);
    const status = await w.status();
    w.pids.add(status.pid);
    const phone = browser(status.connection.service.relay, status.url);
    await phone.pair(pairCode(started.stdout));
    // Frozen: requests already sent wait for it, but the service withdraws it.
    process.kill(status.pid, "SIGSTOP");
    try {
      const { connectionControl, readConnectionRecord } =
        await import("../src/connection.js");
      const record = readConnectionRecord(w.connection)!;
      let state = "ready";
      for (let i = 0; i < 50 && state === "ready"; i++) {
        state = (await connectionControl(record, "hello")).backend.state;
        if (state === "ready") await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(state, "none");
      assert.equal(
        (await phone.send("GET", "/api/bootstrap")).status,
        503,
        "a silent launch stops receiving traffic",
      );
    } finally {
      process.kill(status.pid, "SIGCONT");
    }
    let code = 503;
    for (let i = 0; i < 50 && code !== 200; i++) {
      code = (await phone.send("GET", "/api/bootstrap")).status;
      if (code !== 200) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(
      code,
      200,
      "it proved its socket again and serves the same cookie",
    );
    const after = await w.status();
    assert.equal(after.pid, status.pid);
    assert.equal(
      after.connection.service.backend.generation,
      status.connection.generation,
    );
  } finally {
    await w.cleanup();
  }
});

test("a crashed connection service leaves no cloudflared behind after loop stop", async () => {
  const w = await workspace();
  try {
    await w.loop(w.harness);
    const status = await w.status();
    w.pids.add(status.pid);
    const { pid, tunnel } = status.connection.service;
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid));
    assert(alive(tunnel.pid), "its cloudflared outlived it");
    const crashed = await w.status();
    assert.equal(crashed.connection.service.state, "exited");
    await w.loop(["stop"]);
    await until(() => !alive(tunnel.pid));
    assert(!alive(status.pid));
    assert(!existsSync(join(w.connection, "connection.json")));
  } finally {
    await w.cleanup();
  }
});

test("loop start restores a crashed connection service behind the running application", async () => {
  const w = await workspace();
  try {
    await w.loop(w.harness);
    const before = await w.status();
    w.pids.add(before.pid);
    const { pid, tunnel } = before.connection.service;
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid));
    for (let i = 0; (await w.status()).connection.registered !== false; i++) {
      assert(i < 50, "the application never noticed the service exited");
      await new Promise((r) => setTimeout(r, 200));
    }

    const project = w.harness[w.harness.indexOf("--project") + 1];
    const { stdout } = await w.loop(["start", "--project", project]);
    const after = await w.status();
    assert.equal(after.pid, before.pid, "the application kept running");
    const service = after.connection.service;
    assert.equal(service.state, "running");
    assert.notEqual(service.pid, pid);
    assert.equal(service.tunnel.state, "ready");
    assert.equal(after.connection.registered, true);
    assert.notEqual(
      after.url,
      before.url,
      "a new Quick Tunnel has a new address",
    );
    assert.equal(after.url, service.url, "the application adopted it");
    assert.match(stdout, /public address changed/);
    assert(
      stdout.includes(after.url + "/#pair="),
      "the code is for the new address",
    );
    await until(() => !alive(tunnel.pid));
    assert.equal(w.tunnelPids().length, 2);

    // The code pairs a browser at the new address, served by the same application.
    const phone = browser(service.relay, after.url);
    await phone.pair(pairCode(stdout));
    assert.equal((await phone.send("GET", "/api/bootstrap")).status, 200);
  } finally {
    await w.cleanup();
  }
});

test("loop pair refuses a code once the connection service is gone", async () => {
  const w = await workspace();
  try {
    await w.loop(w.harness);
    const before = await w.status();
    w.pids.add(before.pid);
    const { pid } = before.connection.service;
    // The application keeps serving and still reports the address its dead
    // service held, so a code would link to a tunnel that no longer exists.
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid));
    for (let i = 0; (await w.status()).connection.registered !== false; i++) {
      assert(i < 50, "the application never noticed the service exited");
      await new Promise((r) => setTimeout(r, 200));
    }
    const attempt = await w.loop(["pair"]).then(
      (done) => ({ failed: false, ...done }),
      (error: any) => ({
        failed: true,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? ""),
      }),
    );
    assert.equal(
      attempt.failed,
      true,
      "loop pair reported success: " + attempt.stdout,
    );
    assert.match(attempt.stderr, /connection service is not running/);
    assert.match(attempt.stderr, /loop start/, "the error says how to recover");
    assert(
      !/#(?:pair|fleet)=/.test(attempt.stdout + attempt.stderr),
      "no code was issued",
    );
    const after = await w.status();
    assert.equal(after.pid, before.pid, "the application was left alone");
    assert.equal(after.connection.service.state, "exited");

    // Recovering the service makes pairing available again, at its address.
    const project = w.harness[w.harness.indexOf("--project") + 1];
    await w.loop(["start", "--project", project]);
    const paired = await w.loop(["pair"]);
    const serving = await w.status();
    assert.equal(serving.connection.registered, true);
    assert(
      paired.stdout.includes(serving.url + "/#pair="),
      "the code is for the live address",
    );
  } finally {
    await w.cleanup();
  }
});

test("restart from another directory repeats a foreground launch's project and paths", async () => {
  const w = await workspace();
  try {
    const project = await realpath(
      w.harness[w.harness.indexOf("--project") + 1],
    );
    const log = join(w.base, "foreground.log");
    // Implicit project and a relative executable, from the project directory.
    const app = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("src/cli.ts"),
        "codex",
        "--executable",
        "../codex",
        "--billing",
        "existing",
        "--local-only",
        "--foreground",
      ],
      {
        cwd: project,
        detached: true,
        stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
        env: w.env,
      },
    );
    app.unref();
    let before: any;
    const end = Date.now() + 60000;
    while (!(before = await w.status().catch(() => undefined))?.pid) {
      assert(
        Date.now() < end,
        "the foreground launch never started: " + readFileSync(log, "utf8"),
      );
      await new Promise((r) => setTimeout(r, 250));
    }
    w.pids.add(before.pid);
    assert.equal(before.project, project);
    const launch = JSON.parse(
      readFileSync(join(w.env.LOOP_HOME, "workspace", "launch.json"), "utf8"),
    ).args;
    assert.equal(launch[launch.indexOf("--project") + 1], project);
    assert.equal(
      launch[launch.indexOf("--executable") + 1],
      join(w.base, "codex"),
    );
    assert(!launch.includes("--foreground"));

    // This test runs from the repository, not the project directory.
    assert.notEqual(process.cwd(), project);
    await w.loop(["restart"]);
    const after = await w.status();
    w.pids.add(after.pid);
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.project, project);
    assert.equal(after.harnesses[0].name, "codex");
    assert.equal(after.harnesses[0].billing.mode, "existing");
    assert.equal(after.connection.mode, "local");
  } finally {
    await w.cleanup();
  }
});

test("an incompatible connection service is reported, never silently replaced", async () => {
  const w = await workspace();
  // Stands in for a service from a future release that speaks protocol 99.
  await mkdir(w.connection, { recursive: true, mode: 0o700 });
  const run = ensureRunDir(w.connection);
  const control = join(run, "control.sock");
  const token = "t".repeat(43);
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        protocol: 99,
        instance,
        version: "9.9.9",
        tunnel: { state: "ready" },
        origin: "https://future-loop.trycloudflare.com",
      }),
    );
  });
  const instance = randomUUID();
  await new Promise<void>((r) => server.listen(control, r));
  try {
    writeFileSync(
      join(w.connection, "connection.json"),
      JSON.stringify({
        schema: 1,
        protocol: 99,
        version: "9.9.9",
        instance,
        pid: process.pid,
        identity: identity(process.pid),
        pidNamespace: pidNamespace(),
        control,
        token,
        mode: { kind: "quick" },
        startedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    await assert.rejects(w.loop(w.harness), /protocol 99.*loop stop/s);
    assert.equal(w.tunnelPids().length, 0, "no replacement tunnel was started");
    assert(alive(process.pid));
  } finally {
    await new Promise((r) => server.close(r));
    await rm(join(w.connection, "connection.json"), { force: true });
    await w.cleanup();
  }
});

test("local-only mode never starts the connection service or cloudflared", async () => {
  const w = await workspace();
  try {
    const { stdout } = await w.loop([...w.harness, "--local-only"]);
    assert.match(stdout, /http:\/\/127\.0\.0\.1:\d+\/#pair=/);
    const status = await w.status();
    w.pids.add(status.pid);
    assert.equal(status.connection.mode, "local");
    assert.equal(w.tunnelPids().length, 0);
    assert(!existsSync(join(w.connection, "connection.json")));
    const launch = JSON.parse(
      await readFile(join(w.env.LOOP_HOME, "workspace", "launch.json"), "utf8"),
    );
    assert(launch.args.includes("--local-only"));
    await w.loop(["restart"]);
    const after = await w.status();
    w.pids.add(after.pid);
    assert.equal(after.connection.mode, "local");
    assert.equal(w.tunnelPids().length, 0);
    // There is no connection service to require: pairing stays available.
    assert.match(
      (await w.loop(["pair"])).stdout,
      /http:\/\/127\.0\.0\.1:\d+\/#pair=/,
    );
  } finally {
    await w.cleanup();
  }
});

/**
 * launchd as the CLI drives it: kickstart -k reruns the loaded job, while
 * bootout/bootstrap reload a rewritten plist. The job file stands in for the
 * loaded configuration, so a plist change only takes effect on bootstrap.
 */
const LAUNCHCTL = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const file = process.env.LOOP_TEST_LAUNCHD_JOB;
const job = JSON.parse(readFileSync(file, "utf8"));
const alive = () => { if (!job.pid) return false; try { process.kill(job.pid, 0); if (process.platform === "linux" && readFileSync("/proc/" + job.pid + "/stat", "utf8").split(") ")[1][0] === "Z") return false; return true; } catch { return false; } };
const save = (next) => writeFileSync(file, JSON.stringify({ ...job, ...next }));
const stop = (then) => {
  if (alive()) try { process.kill(job.pid, "SIGTERM"); } catch {}
  // Both managers escalate rather than wait forever: a stopped or wedged
  // process never gets round to handling SIGTERM.
  const kill = setTimeout(() => { try { process.kill(job.pid, "SIGKILL"); } catch {} }, 2000);
  (function wait() {
    if (alive()) return setTimeout(wait, 50);
    clearTimeout(kill);
    then();
  })();
};
const start = (args) => {
  const out = openSync(job.log, "a");
  // A plist names the built CLI; this repository runs from TypeScript, which
  // the real build does not need.
  const argv = args[0].endsWith(".ts") ? ["--import", "tsx", ...args] : args;
  const child = spawn(process.execPath, argv, { detached: true, stdio: ["ignore", out, out], env: { ...process.env, LOOP_SERVICE: process.env.LOOP_TEST_SUPERVISOR ?? "launchd" } });
  child.unref();
  save({ pid: child.pid, args });
};
/** The launch a rewritten unit asks for; fixture paths carry no entities. */
const written = (path) => {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".plist")) {
    const array = text.match(/<key>ProgramArguments<\\/key><array>(.*?)<\\/array>/s)[1];
    return [...array.matchAll(/<string>([^<]*)<\\/string>/g)].map((m) => m[1]).slice(1);
  }
  const line = text.match(/^ExecStart=(.*)$/m)[1];
  return [...line.matchAll(/"((?:\\\\.|[^"\\\\])*)"/g)].map((m) => m[1]).slice(1);
};
const command = process.argv.slice(2);
// launchd reruns the loaded job; only bootstrap reads the plist again. systemd
// reloads a changed unit on daemon-reload, then restarts what it has loaded.
if (command[0] === "kickstart") stop(() => start(job.args));
else if (command[0] === "bootout") stop(() => save({ pid: 0 }));
else if (command[0] === "bootstrap") stop(() => start(written(command[2])));
else if (command.includes("daemon-reload"))
  save({ args: written(join(homedir(), ".config/systemd/user", "loop.service")) });
else if (command.includes("restart")) stop(() => start(job.args));
else process.exit(1);
`;

/** bash install leaves the CLI inside the checkout it was run from. */
const CHECKOUT_CLI = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--import", "tsx", __CLI__, ...process.argv.slice(2)], { stdio: "inherit" });
// A wrapper the service manager can stop: the signal reaches the application.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
`;

test("a stopped or hung application under an installed service restarts inside its unit", async () => {
  const w = await workspace();
  const mac = process.platform === "darwin";
  const supervisor = mac ? "launchd" : "systemd";
  try {
    const bin = join(w.base, "bin");
    const home = join(w.base, "home");
    const units = join(
      home,
      mac ? "Library/LaunchAgents" : ".config/systemd/user",
    );
    await mkdir(bin, { recursive: true });
    await mkdir(units, { recursive: true });
    for (const name of ["launchctl", "systemctl"])
      writeFileSync(join(bin, name), LAUNCHCTL, { mode: 0o755 });
    const job = join(w.base, "launchd-job.json");
    Object.assign(w.env, {
      PATH: `${bin}:${process.env.PATH}`,
      LOOP_TEST_LAUNCHD_JOB: job,
      LOOP_TEST_SUPERVISOR: supervisor,
      HOME: home,
    });
    const project = w.harness[w.harness.indexOf("--project") + 1];
    const { serviceDefinitions, SERVICES } = await import("../src/service.js");
    const names = mac ? SERVICES.darwin : SERVICES.linux;
    const launch = [...w.harness, "--local-only"];
    writeFileSync(
      join(units, mac ? `${names.app}.plist` : names.app),
      serviceDefinitions(
        process.platform,
        process.execPath,
        resolve("src/cli.ts"),
        w.env.LOOP_HOME,
        project,
        `${bin}:${process.env.PATH}`,
        null,
        launch,
      ).app.contents,
      { mode: 0o600 },
    );
    const log = join(w.base, "service.log");
    const args = [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      ...launch,
      "--foreground",
    ];
    const start = () => {
      const app = spawn(process.execPath, args, {
        detached: true,
        stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
        env: { ...w.env, LOOP_SERVICE: supervisor },
      });
      app.unref();
      writeFileSync(job, JSON.stringify({ pid: app.pid, args, log }));
      return app.pid!;
    };
    const ready = async (what: string) => {
      let status: any;
      const end = Date.now() + 60000;
      while (!(status = await w.status().catch(() => undefined))?.pid) {
        assert(Date.now() < end, `${what}: ` + readFileSync(log, "utf8"));
        await new Promise((r) => setTimeout(r, 250));
      }
      w.pids.add(status.pid);
      return status;
    };
    const owner = () => JSON.parse(readFileSync(job, "utf8")).pid;
    start();
    const first = await ready("the service-managed launch never started");
    assert.equal(first.supervisor, supervisor);

    // The application is gone but its unit is still installed. Starting a
    // detached one would leave the manager relaunching its own copy, which
    // then dies on the workspace lock: the restart belongs to the manager.
    process.kill(first.pid, "SIGKILL");
    await until(() => !alive(first.pid));
    await w.loop(["restart"], 120000);
    const revived = await ready("the service never restarted the application");
    assert.notEqual(revived.pid, first.pid);
    assert.equal(revived.pid, owner(), "the manager owns the application");
    assert.equal(revived.supervisor, supervisor);

    // Same for an application too hung to answer: --force goes to the manager
    // rather than stopping it and spawning one outside the unit.
    process.kill(revived.pid, "SIGSTOP");
    try {
      await w.loop(["restart", "--force"], 120000);
    } finally {
      try {
        process.kill(revived.pid, "SIGCONT");
      } catch {}
    }
    const forced = await ready("the hung application was never replaced");
    assert.notEqual(forced.pid, revived.pid);
    assert.equal(forced.pid, owner(), "the manager owns the replacement");
    assert(!alive(revived.pid), "the hung application was left running");
  } finally {
    await w.cleanup();
  }
});

test("an upgrade points a checkout-installed service at the newly installed build", async () => {
  const w = await workspace();
  const mac = process.platform === "darwin";
  const supervisor = mac ? "launchd" : "systemd";
  try {
    const bin = join(w.base, "bin");
    const home = join(w.base, "home");
    const units = join(
      home,
      mac ? "Library/LaunchAgents" : ".config/systemd/user",
    );
    await mkdir(bin, { recursive: true });
    await mkdir(units, { recursive: true });
    for (const name of ["launchctl", "systemctl"])
      writeFileSync(join(bin, name), LAUNCHCTL, { mode: 0o755 });
    const job = join(w.base, "launchd-job.json");
    Object.assign(w.env, {
      PATH: `${bin}:${process.env.PATH}`,
      LOOP_TEST_LAUNCHD_JOB: job,
      LOOP_TEST_SUPERVISOR: supervisor,
      HOME: home,
    });
    // The service was installed from a checkout, so its unit names that
    // checkout's CLI. loop upgrade installs into npm's global prefix and hands
    // the restart to the CLI it installed: a different absolute path.
    const checkout = join(w.base, "checkout", "dist", "cli.js");
    const installed = resolve("src/cli.ts");
    await mkdir(dirname(checkout), { recursive: true });
    writeFileSync(
      checkout,
      CHECKOUT_CLI.replace("__CLI__", JSON.stringify(installed)),
      { mode: 0o755 },
    );

    const project = w.harness[w.harness.indexOf("--project") + 1];
    const { serviceDefinitions, SERVICES } = await import("../src/service.js");
    const names = mac ? SERVICES.darwin : SERVICES.linux;
    const launch = [...w.harness, "--local-only"];
    const unit = join(units, mac ? `${names.app}.plist` : names.app);
    writeFileSync(
      unit,
      serviceDefinitions(
        process.platform,
        process.execPath,
        checkout,
        w.env.LOOP_HOME,
        project,
        `${bin}:${process.env.PATH}`,
        null,
        launch,
      ).app.contents,
      { mode: 0o600 },
    );
    const log = join(w.base, "service.log");
    const args = [checkout, ...launch, "--foreground"];
    const app = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
      env: { ...w.env, LOOP_SERVICE: supervisor },
    });
    app.unref();
    writeFileSync(job, JSON.stringify({ pid: app.pid, args, log }));
    let before: any;
    const end = Date.now() + 60000;
    while (!(before = await w.status().catch(() => undefined))?.pid) {
      assert(
        Date.now() < end,
        "the checkout-installed service never started: " +
          readFileSync(log, "utf8"),
      );
      await new Promise((r) => setTimeout(r, 250));
    }
    w.pids.add(before.pid);
    w.pids.add(app.pid!);
    assert.equal(before.supervisor, supervisor);

    // Running restart from a different checkout must retain the installed
    // entrypoint unless this is explicitly an upgrade handoff.
    const originalUnit = readFileSync(unit, "utf8");
    await w.loop(["restart"], 120000);
    const restarted = await w.status();
    w.pids.add(restarted.pid);
    assert.notEqual(restarted.pid, before.pid);
    assert.equal(readFileSync(unit, "utf8"), originalUnit);
    assert.equal(JSON.parse(readFileSync(job, "utf8")).args[0], checkout);
    before = restarted;

    // The handoff loop upgrade performs once the new build is installed.
    const { stdout } = await w.loop(
      ["restart", "--upgraded-from", "0.0.0-previous"],
      120000,
    );
    const after = await w.status();
    w.pids.add(after.pid);
    assert.notEqual(after.pid, before.pid);
    // The unit launches the installed build, with the rest of its launch kept.
    const rewritten = readFileSync(unit, "utf8");
    assert(rewritten.includes(installed), "the unit names the installed build");
    assert(
      !rewritten.includes(checkout),
      "the unit no longer names the checkout",
    );
    assert(
      rewritten.includes(project),
      "the saved launch survived the rewrite",
    );
    // ...and the manager relaunched that build, not the one it had loaded.
    const loaded = JSON.parse(readFileSync(job, "utf8"));
    assert.equal(loaded.pid, after.pid, "the manager owns the new application");
    assert.equal(loaded.args[0], installed, "it launched the installed build");
    assert.equal(
      after.release,
      JSON.parse(readFileSync("package.json", "utf8")).version,
    );
    assert.equal(after.supervisor, supervisor);
    assert.equal(after.project, before.project);
    assert.equal(after.connection.mode, "local");
    assert(!alive(before.pid));
    assert.match(
      stdout,
      /Pointed the Loop service at the newly installed build/,
    );
    assert.match(stdout, /Loop restarted under its service/);

    // Already the installed build: the next restart is an ordinary one.
    const again = await w.loop(
      ["restart", "--upgraded-from", "0.0.0-previous"],
      120000,
    );
    assert.doesNotMatch(again.stdout, /Pointed the Loop service/);
    const last = await w.status();
    w.pids.add(last.pid);
    assert.notEqual(last.pid, after.pid);
  } finally {
    await w.cleanup();
  }
});

for (const mode of [
  ["--local-only"],
  ["--public-url", "https://loop-proxy.example.test"],
])
  test(`a service-managed ${mode[0]} launch restarts without a connection lease`, async () => {
    const w = await workspace();
    const bin = join(w.base, "bin");
    await mkdir(bin);
    for (const name of ["launchctl", "systemctl"])
      writeFileSync(join(bin, name), LAUNCHCTL, { mode: 0o755 });
    const home = join(w.base, "home");
    const mac = process.platform === "darwin";
    const units = join(
      home,
      mac ? "Library/LaunchAgents" : ".config/systemd/user",
    );
    await mkdir(units, { recursive: true });
    const { serviceDefinitions } = await import("../src/service.js");
    const supervisor = mac ? "launchd" : "systemd";
    const installed = serviceDefinitions(
      process.platform,
      process.execPath,
      resolve("src/cli.ts"),
      w.env.LOOP_HOME,
      w.base,
      process.env.PATH!,
      null,
      [...w.harness, ...mode],
    ).app;
    const unit = join(units, mac ? `${installed.name}.plist` : installed.name);
    writeFileSync(unit, installed.contents);
    const job = join(w.base, "launchd-job.json");
    Object.assign(w.env, {
      PATH: `${bin}:${process.env.PATH}`,
      LOOP_TEST_LAUNCHD_JOB: job,
      LOOP_TEST_SUPERVISOR: supervisor,
      HOME: home,
    });
    try {
      const args = [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        ...w.harness,
        ...mode,
        "--foreground",
      ];
      const log = join(w.base, "service.log");
      const app = spawn(process.execPath, args, {
        detached: true,
        stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
        env: { ...w.env, LOOP_SERVICE: supervisor },
      });
      app.unref();
      writeFileSync(job, JSON.stringify({ pid: app.pid, args, log }));
      let before: any;
      const end = Date.now() + 60000;
      while (!(before = await w.status().catch(() => undefined))?.pid) {
        assert(
          Date.now() < end,
          "the service-managed launch never started: " +
            readFileSync(log, "utf8"),
        );
        await new Promise((r) => setTimeout(r, 250));
      }
      w.pids.add(before.pid);
      assert.equal(before.supervisor, supervisor);
      assert.equal(
        before.connection.mode,
        mode[0] === "--local-only" ? "local" : "external-proxy",
      );

      const { stdout } = await w.loop(["restart"], 60000);
      assert.match(stdout, /Loop restarted under its service/);
      const after = await w.status();
      w.pids.add(after.pid);
      assert.notEqual(after.pid, before.pid);
      assert.equal(
        after.pid,
        JSON.parse(readFileSync(job, "utf8")).pid,
        "the manager ran the new application",
      );
      assert.equal(after.supervisor, supervisor);
      assert(!alive(before.pid));
      assert.equal(
        w.tunnelPids().length,
        0,
        "no cloudflared without a managed tunnel",
      );
      assert.equal(
        readFileSync(unit, "utf8"),
        installed.contents,
        "ordinary restart retained the installed entrypoint",
      );
    } finally {
      await w.cleanup();
    }
  });

for (const installation of ["absent", "another workspace"])
  test(`an inherited supervisor cannot restart a service for ${installation}`, async () => {
    const supervisor = process.platform === "darwin" ? "launchd" : "systemd";
    const w = await workspace({ LOOP_SERVICE: supervisor });
    const home = join(w.base, "home");
    const bin = join(w.base, "bin");
    const calls = join(w.base, "manager-calls.log");
    const saved: { path: string; contents: string }[] = [];
    try {
      await mkdir(home);
      await mkdir(bin);
      // A broken ownership check fails against a fixture manager. It can
      // never invoke the host's real service manager, even when run in Loop.
      for (const name of ["launchctl", "systemctl"])
        writeFileSync(
          join(bin, name),
          `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.LOOP_TEST_MANAGER_LOG, process.argv.join(" ") + "\\n");
process.exit(91);
`,
          { mode: 0o755 },
        );
      Object.assign(w.env, {
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        LOOP_TEST_MANAGER_LOG: calls,
      });
      if (installation === "another workspace") {
        const mac = process.platform === "darwin";
        const units = join(
          home,
          mac ? "Library/LaunchAgents" : ".config/systemd/user",
        );
        await mkdir(units, { recursive: true });
        const { serviceDefinitions } = await import("../src/service.js");
        const other = serviceDefinitions(
          process.platform,
          process.execPath,
          "/other/dist/cli.js",
          join(w.base, "other-state"),
          w.base,
          process.env.PATH!,
        );
        for (const definition of [other.app, other.connection]) {
          if (!definition) continue;
          const path = join(
            units,
            mac ? `${definition.name}.plist` : definition.name,
          );
          writeFileSync(path, definition.contents);
          saved.push({ path, contents: definition.contents });
        }
      }
      await w.loop([...w.harness, "--local-only"]);
      let before = await w.status();
      w.pids.add(before.pid);
      assert.equal(
        before.supervisor,
        supervisor,
        "the child inherited its parent's supervisor claim",
      );
      for (const args of [
        ["restart"],
        ["restart", "--upgraded-from", "0.0.0-previous"],
      ]) {
        await w.loop(args);
        const after = await w.status();
        w.pids.add(after.pid);
        assert.equal(after.state, "ready");
        assert.notEqual(after.pid, before.pid);
        assert(!alive(before.pid), "only the requested fixture was replaced");
        assert(!existsSync(calls), "neither service manager was invoked");
        for (const unit of saved)
          assert.equal(readFileSync(unit.path, "utf8"), unit.contents);
        before = after;
      }
    } finally {
      await w.cleanup();
    }
  });
