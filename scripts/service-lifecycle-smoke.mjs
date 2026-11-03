// Linux user systemd: `loop service install` with a real Quick Tunnel. The
// application unit restarts (via loop restart and systemctl) while the
// connection unit, its cloudflared and the address stay; loop stop stays
// stopped. Needs a user systemd manager (CI enables lingering) and installs
// into a private npm prefix and LOOP_HOME. Uses the fixture harness.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const exec = promisify(execFile);
assert.equal(process.platform, "linux", "systemd smoke runs on Linux");
await mkdir(".tmp", { recursive: true });
const base = await mkdtemp(resolve(".tmp/service-smoke-"));
const prefix = join(base, "prefix");
const project = join(base, "project");
await mkdir(project);
const fixture = join(base, "codex");
await copyFile("test/harness.mjs", fixture);
await chmod(fixture, 0o755);
const env = {
  ...process.env,
  npm_config_prefix: prefix,
  LOOP_HOME: join(base, "state"),
};
delete env.LOOP_TEST_CLOUDFLARED;
const units = join(homedir(), ".config/systemd/user");
const systemctl = (...args) => exec("systemctl", ["--user", ...args], { env });
const mainPid = async (unit) =>
  Number(
    (await systemctl("show", "-p", "MainPID", "--value", unit)).stdout.trim(),
  );
const active = async (unit) =>
  (await systemctl("is-active", unit).catch((e) => e)).stdout.trim();
const cgroup = (pid) => readFileSync(`/proc/${pid}/cgroup`, "utf8");
const alive = (pid) => existsSync(`/proc/${pid}`);
let loop;
try {
  const { stdout } = await exec(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", base],
    { maxBuffer: 1e6 },
  );
  await exec(
    "npm",
    [
      "install",
      "-g",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      join(base, JSON.parse(stdout)[0].filename),
    ],
    { env, maxBuffer: 1e6, timeout: 600000 },
  );
  loop = (...args) =>
    exec(join(prefix, "bin", "loop"), args, { env, timeout: 300000 });
  const status = async () =>
    JSON.parse((await loop("status", "--json")).stdout);
  const ready = async (previous) => {
    for (let i = 0; i < 240; i++) {
      const s = await status().catch(() => undefined);
      if (
        s?.pid &&
        s.pid !== previous &&
        s.connection?.registered &&
        s.supervisor === "systemd"
      )
        return s;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("The service-managed application did not become ready");
  };

  // A saved launch (fixture harness, existing billing), then the services.
  await loop(
    "codex",
    "--executable",
    fixture,
    "--project",
    project,
    "--billing",
    "existing",
  );
  await loop("service", "install");
  const before = await ready();
  const service = before.connection.service;
  assert.equal(await mainPid("loop.service"), before.pid);
  assert.equal(await mainPid("loop-connection.service"), service.pid);
  assert.match(
    cgroup(service.tunnel.pid),
    /loop-connection\.service/,
    "cloudflared lives in the connection unit",
  );
  assert.doesNotMatch(cgroup(before.pid), /loop-connection\.service/);
  assert.equal(
    before.harnesses[0]?.name,
    "codex",
    "the unit repeats the saved launch",
  );
  assert.match(before.url, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);

  // Pair through the relay as cloudflared delivers requests.
  const { fleetDeviceFromLink } =
    await import("../dist/shared/fleet-pairing.js");
  const pairUrl = (await loop("pair")).stdout.match(
    /https:\/\/[^\s]+\/#(?:pair|fleet)=[\w-]+/,
  )[0];
  const code = fleetDeviceFromLink(pairUrl, new URL(pairUrl).origin).secret;
  const relay = new URL(service.relay);
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
          res.resume();
          res.on("end", () => {
            if (res.headers["set-cookie"])
              cookie = res.headers["set-cookie"][0].split(";")[0];
            resolve(res.statusCode);
          });
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  assert.equal(
    await send("POST", "/pair", { secret: code, name: "Service fixture" }),
    200,
  );
  assert.equal(await send("GET", "/api/bootstrap"), 200);

  let previous = before.pid;
  for (const restart of [
    () => loop("restart"),
    () => systemctl("restart", "loop.service"),
  ]) {
    await restart();
    const after = await ready(previous);
    assert.equal(await mainPid("loop.service"), after.pid);
    assert(!alive(previous), "the previous application exited");
    assert.equal(after.url, before.url);
    assert.equal(after.connection.service.pid, service.pid);
    assert.equal(after.connection.service.tunnel.pid, service.tunnel.pid);
    assert.equal(await mainPid("loop-connection.service"), service.pid);
    assert.equal(
      await send("GET", "/api/bootstrap"),
      200,
      "the paired cookie still works",
    );
    previous = after.pid;
  }

  // A full stop stays stopped: restart-on-failure doesn't undo it.
  await loop("stop");
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal(await active("loop.service"), "inactive");
  assert.equal(await active("loop-connection.service"), "inactive");
  assert(!alive(service.tunnel.pid) && !alive(service.pid) && !alive(previous));
  await loop("service", "uninstall");
  assert(!existsSync(join(units, "loop.service")));
  assert(!existsSync(join(units, "loop-connection.service")));
  console.log(
    `PASS: systemd user units; loop restart and systemctl restart replaced only the application (cloudflared ${service.tunnel.pid} and the Quick Tunnel address kept, paired cookie valid); loop stop stayed stopped; uninstall removed both units`,
  );
} finally {
  if (loop) await loop("service", "uninstall").catch(() => {});
  await rm(base, { recursive: true, force: true });
}
