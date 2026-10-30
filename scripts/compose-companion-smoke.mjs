import "../runtime/environment.mjs";
// Disposable, uniquely named fixture volumes. Never operates on user projects.
// Runs the shipped two-container companion with a real Quick Tunnel: the
// connection container must survive replacement of the application container.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const project = `loop55-companion-smoke-${randomUUID().slice(0, 8)}`;
const prebuilt = process.argv.includes("--prebuilt");
const args = [
  "compose",
  "-p",
  project,
  "-f",
  resolve("compose.companion.yaml"),
  ...(prebuilt ? ["-f", resolve("scripts/ci/companion-images.yaml")] : []),
];
function compose(extra, input, timeout = 60_000) {
  try {
    return execFileSync("docker", [...args, ...extra], {
      input,
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    }).toString();
  } catch {
    // Captured output can contain device credentials. Do not forward it.
    throw new Error(
      `Companion smoke command failed: ${extra.slice(0, 3).join(" ")}`,
    );
  }
}
const container = (service) => compose(["ps", "-q", service]).trim();
// Requests through the connection container's relay, exactly as cloudflared
// delivers them: original public Host header, browser cookie and Origin.
const RELAY = `
import { readFileSync } from "node:fs";
import { request } from "node:http";
const record = JSON.parse(readFileSync("/data/loop55-connection/connection.json", "utf8"));
export function control(operation) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: record.control, path: "/v1/" + operation, method: "POST",
      headers: { authorization: "Bearer " + record.token, "content-type": "application/json" } }, (res) => {
      let out = ""; res.on("data", (b) => (out += b)); res.on("end", () => resolve(JSON.parse(out)));
    });
    req.on("error", reject); req.end("{}");
  });
}
export const hello = await control("hello");
export function relay(method, path, { cookie, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: hello.relay.port, method, path, headers: {
      host: new URL(hello.origin).host, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}),
      ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
      let out = ""; res.on("data", (b) => (out += b));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
`;
const inConnection = (script) =>
  compose(
    ["exec", "-T", "loop55-connection", "node", "--input-type=module"],
    RELAY + script,
  );
// Waits for the current application launch to finish registering.
const identity = () =>
  JSON.parse(
    inConnection(`
      let now = hello;
      for (let i = 0; i < 60 && now.backend.state !== "ready"; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        now = await control("hello");
      }
      console.log(JSON.stringify({ origin: now.origin, instance: now.instance, pid: now.pid, tunnel: now.tunnel.pid, generation: now.backend.generation, backend: now.backend.state }));
    `),
  );
try {
  compose(["config", "--quiet"]);
  compose(
    [
      "up",
      prebuilt ? "--no-build" : "--build",
      "-d",
      "--wait",
      "--wait-timeout",
      "240",
    ],
    undefined,
    1_500_000,
  );
  compose(["exec", "-T", "loop55-companion", "loop55", "status", "--json"]);
  // No cloudflared, Docker socket, provider home or project in the connection container.
  inConnection(`
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    for (const path of ["/var/run/docker.sock", "/data/loop55", "/workspaces"])
      assert.equal(existsSync(path), false, path);
    assert.equal(hello.tunnel.state, "ready");
    assert.equal(hello.backend.state, "ready");
    assert.match(hello.origin, /^https:\\/\\/[a-z0-9-]+\\.trycloudflare\\.com$/);
  `);
  const before = identity();
  const app = container("loop55-companion");
  const connection = container("loop55-connection");
  // Pair with a one-time code from the application, redeemed through the relay.
  const code = compose(
    ["exec", "-T", "loop55-companion", "node", "--input-type=module"],
    `
    import { control } from "/app/dist/host-control.js";
    import { fleetDeviceFromLink } from "/app/dist/shared/fleet-pairing.js";
    const dir = process.env.LOOP55_HOME + "/workspace";
    const first = await control(dir, "pair");
    console.log(fleetDeviceFromLink(first.url, new URL(first.url).origin).secret);
    `,
  ).trim();
  inConnection(`
    import assert from "node:assert/strict";
    import { writeFile } from "node:fs/promises";
    assert.equal((await relay("GET", "/api/bootstrap")).status, 401);
    const redeem = (origin) => relay("POST", "/pair", { origin, body: { secret: ${JSON.stringify(code)}, name: "Compose fixture" } });
    assert.equal((await redeem("https://wrong.example")).status, 403);
    const paired = await redeem(hello.origin);
    assert.equal(paired.status, 200);
    const cookie = paired.headers["set-cookie"][0].split(";")[0];
    assert.equal((await redeem(hello.origin)).status, 403, "pairing codes are single-use");
    const bootstrap = await relay("GET", "/api/bootstrap", { cookie });
    assert.equal(bootstrap.status, 200);
    assert.equal(JSON.parse(bootstrap.body).environmentName, ${JSON.stringify(`Docker · ${project}/loop55-companion`)});
    // The private probe namespace is never forwarded from the public listener.
    assert.equal((await relay("GET", "/__loop55/backend-probe?nonce=" + "a".repeat(20))).status, 404);
    // Through Cloudflare itself (DNS for a new Quick Tunnel can lag briefly).
    let viaTunnel = 0;
    for (let i = 0; i < 45 && viaTunnel !== 200; i++) {
      viaTunnel = await fetch(hello.origin + "/api/bootstrap", { headers: { cookie } }).then((r) => r.status, () => 0);
      if (viaTunnel !== 200) await new Promise((r) => setTimeout(r, 2000));
    }
    assert.equal(viaTunnel, 200, "paired request through the real Quick Tunnel");
    const session = JSON.parse((await relay("GET", "/session", { cookie })).body);
    // Disposable fixture credentials, kept only in this run's private volume.
    await writeFile("/data/loop55-connection/smoke-device.json", JSON.stringify({ cookie, id: session.device.id }), { mode: 0o600 });
  `);
  // Replace only the application container, as an app-only update does.
  compose(
    [
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "240",
      "loop55-companion",
    ],
    undefined,
    300_000,
  );
  const after = identity();
  if (container("loop55-companion") === app)
    throw new Error("The application container was not replaced");
  if (container("loop55-connection") !== connection)
    throw new Error(
      "Replacing the application recreated the connection container",
    );
  for (const key of ["origin", "instance", "pid", "tunnel"])
    if (after[key] !== before[key])
      throw new Error(
        `Connection ${key} changed across application replacement`,
      );
  if (!(after.generation > before.generation) || after.backend !== "ready")
    throw new Error(
      "The replacement application did not register a new generation",
    );
  inConnection(`
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    const { cookie } = JSON.parse(await readFile("/data/loop55-connection/smoke-device.json", "utf8"));
    assert.equal((await relay("GET", "/api/bootstrap", { cookie })).status, 200, "same paired browser after replacement");
    let viaTunnel = 0;
    for (let i = 0; i < 15 && viaTunnel !== 200; i++) {
      viaTunnel = await fetch(hello.origin + "/api/bootstrap", { headers: { cookie } }).then((r) => r.status, () => 0);
      if (viaTunnel !== 200) await new Promise((r) => setTimeout(r, 2000));
    }
    assert.equal(viaTunnel, 200);
  `);
  // A stopped application leaves a truthful 503 at the same address.
  compose(["stop", "--timeout", "40", "loop55-companion"], undefined, 90_000);
  inConnection(`
    import assert from "node:assert/strict";
    const down = await relay("GET", "/api/bootstrap");
    assert.equal(down.status, 503);
    assert.equal(down.headers["x-loop55-unavailable"], "restarting");
    assert.doesNotMatch(down.body, /data|loop55-connection|workspace/);
  `);
  compose(
    [
      "up",
      "-d",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "240",
      "loop55-companion",
    ],
    undefined,
    300_000,
  );
  // Revocation persists across an application restart; the connection stays.
  compose(
    ["exec", "-T", "loop55-companion", "node", "--input-type=module"],
    `
    import { control } from "/app/dist/host-control.js";
    const devices = await control(process.env.LOOP55_HOME + "/workspace", "devices");
    for (const device of devices) await control(process.env.LOOP55_HOME + "/workspace", "revoke", { id: device.id });
    `,
  );
  compose(
    ["restart", "--timeout", "40", "loop55-companion"],
    undefined,
    90_000,
  );
  compose(
    [
      "up",
      "-d",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "240",
      "loop55-companion",
    ],
    undefined,
    300_000,
  );
  inConnection(`
    import assert from "node:assert/strict";
    import { readFile, unlink } from "node:fs/promises";
    const { cookie } = JSON.parse(await readFile("/data/loop55-connection/smoke-device.json", "utf8"));
    let status = 0;
    for (let i = 0; i < 30 && status !== 401; i++) {
      status = (await relay("GET", "/api/bootstrap", { cookie })).status;
      if (status !== 401) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(status, 401, "a revoked device stays revoked");
    await unlink("/data/loop55-connection/smoke-device.json");
  `);
  if (identity().tunnel !== before.tunnel)
    throw new Error("cloudflared changed across application restarts");
  console.log(
    `PASS: two-container companion with a real Quick Tunnel; app container replaced (${app.slice(0, 12)} -> ${container("loop55-companion").slice(0, 12)}) while connection container ${connection.slice(0, 12)}, cloudflared PID ${before.tunnel} and its address stayed; paired cookie kept working through the relay and Cloudflare; 503 while stopped; pairing single-use; revocation durable`,
  );
} finally {
  compose(["down", "--volumes", "--timeout", "40"], undefined, 90_000);
}
