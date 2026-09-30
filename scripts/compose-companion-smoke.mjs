// Disposable, uniquely named fixture volumes. Never operates on user projects.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const project = `loop-companion-smoke-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), project));
const override = join(dir, "smoke.yaml");
writeFileSync(
  override,
  'services:\n  loop-companion:\n    command: ["loop", "start", "--foreground", "--local-only"]\n',
);
const args = [
  "compose",
  "-p",
  project,
  "-f",
  resolve("compose.companion.yaml"),
  "-f",
  override,
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
    throw new Error(`Companion smoke command failed: ${extra[0]}`);
  }
}
try {
  compose(["config", "--quiet"]);
  compose(
    ["up", "--build", "-d", "--wait", "--wait-timeout", "120"],
    undefined,
    1_200_000,
  );
  compose(["exec", "-T", "loop-companion", "loop", "status", "--json"]);
  compose(
    ["exec", "-T", "loop-companion", "node", "--input-type=module"],
    `
    import assert from "node:assert/strict";
    import { execFileSync } from "node:child_process";
    import { existsSync } from "node:fs";
    import { dirname, resolve } from "node:path";
    import { hapi } from "/app/dist/local-runtime.js";
    // Resolve the shipped artifact through the production loader. Baked mode
    // refuses a rebuild, so this also checks the retained readiness/layout.
    const binary = await hapi("/unused-build-root");
    execFileSync(binary, ["--version"], { stdio: "ignore" });
    const source = resolve(dirname(binary), "../../..");
    assert.equal(existsSync(source + "/node_modules"), false);
    assert.equal(existsSync(source + "/.git"), false);
    assert.equal(existsSync(source + "/hapi-source.tar.gz"), true);
    `,
  );
  compose(
    ["exec", "-T", "loop-companion", "node", "--input-type=module"],
    `
    import assert from "node:assert/strict";
    import { writeFile } from "node:fs/promises";
    import { control } from "/app/dist/host-control.js";
    const dir = process.env.LOOP_HOME + "/workspace";
    const status = await control(dir, "status");
    const origin = status.url;
    assert.equal((await fetch(origin + "/api/bootstrap")).status, 401);
    const pair = await control(dir, "pair");
    const secret = new URLSearchParams(new URL(pair.url).hash.slice(1)).get("pair");
    async function redeem(originHeader) {
      return fetch(origin + "/pair", {method: "POST", headers: {Origin: originHeader, "Content-Type": "application/json"}, body: JSON.stringify({secret, name: "Compose fixture"})});
    }
    assert.equal((await redeem("https://wrong.example")).status, 403);
    const paired = await redeem(origin);
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    assert.equal((await redeem(origin)).status, 403);
    assert.equal((await fetch(origin + "/api/bootstrap", {headers: {cookie}})).status, 200);
    const session = await fetch(origin + "/session", {headers: {cookie}}).then(r => r.json());
    const unused = await control(dir, "pair");
    // These are disposable fixture credentials, retained only in this run's
    // private volume so the test never prints them or passes them as argv.
    await writeFile(process.env.LOOP_HOME + "/smoke-device.json", JSON.stringify({
      cookie, id: session.device.id,
      secret: new URLSearchParams(new URL(unused.url).hash.slice(1)).get("pair"),
    }), {mode: 0o600});
  `,
  );
  // Exercise SIGTERM, lock release and persistence using the same named volumes.
  for (const revoked of [false, true]) {
    compose(
      ["restart", "--timeout", "40", "loop-companion"],
      undefined,
      90_000,
    );
    compose(
      ["up", "-d", "--wait", "--wait-timeout", "120"],
      undefined,
      150_000,
    );
    compose(
      ["exec", "-T", "loop-companion", "node", "--input-type=module"],
      `
      import assert from "node:assert/strict";
      import { readFile, unlink } from "node:fs/promises";
      import { control } from "/app/dist/host-control.js";
      const root = process.env.LOOP_HOME;
      const dir = root + "/workspace";
      const fixture = JSON.parse(await readFile(root + "/smoke-device.json", "utf8"));
      const {url: origin} = await control(dir, "status");
      const request = () => fetch(origin + "/api/bootstrap", {headers: {cookie: fixture.cookie}});
      assert.equal((await request()).status, ${revoked ? 401 : 200});
      const stale = await fetch(origin + "/pair", {
        method: "POST", headers: {Origin: origin, "Content-Type": "application/json"},
        body: JSON.stringify({secret: fixture.secret}),
      });
      assert.equal(stale.status, 403);
      if (${revoked}) {
        await unlink(root + "/smoke-device.json");
      } else {
        await control(dir, "revoke", {id: fixture.id});
        assert.equal((await request()).status, 401);
      }
      `,
    );
  }
  console.log(
    "PASS: isolated companion, admin health, pairing, origin rejection, single-use code, API authorization, restart persistence and durable revocation",
  );
} finally {
  try {
    compose(["down", "--volumes", "--timeout", "40"], undefined, 90_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
