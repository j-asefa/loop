import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConnectionRecord } from "../src/connection.js";
import { createHost } from "./helpers/gateway.js";

async function namedService(t: TestContext, origin: string) {
  const dir = await mkdtemp(join(tmpdir(), "loop-origin-"));
  const config = join(dir, "fixture.yml");
  const log = join(dir, "tunnels.log");
  await writeFile(config, "{}\n");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/connection-daemon.ts",
      "--dir",
      dir,
      "--root",
      dir,
      "--tunnel-name",
      "fixture",
      "--public-url",
      origin,
      "--tunnel-config",
      config,
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        LOOP_TEST_CLOUDFLARED: resolve("test/fixtures/fake-cloudflared.mjs"),
        LOOP_TEST_TUNNEL_LOG: log,
      },
    },
  );
  const exit = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exit;
    await rm(dir, { recursive: true, force: true });
  });
  const [message] = await once(child, "message");
  return { message, exit, dir, log };
}

test(
  "named connection startup rejects non-bare origins before starting a tunnel",
  { timeout: 20000 },
  async (t) => {
    for (const origin of [
      "https://fixture.example/path",
      "https://fixture.example/?query=1",
      "https://fixture.example/#fragment",
      "https://user:pass@fixture.example",
      "http://fixture.example",
      "not-a-url",
    ]) {
      const child = await namedService(t, origin);
      assert.equal(child.message.ready, undefined, origin);
      assert.match(child.message.error, /bare HTTPS origin/);
      assert.equal((await child.exit)[0], 1);
      assert.equal(
        existsSync(child.log),
        false,
        "invalid origin never launches cloudflared",
      );
      assert.equal(existsSync(join(child.dir, "connection.json")), false);
    }
  },
);

test(
  "named connection startup canonicalizes a valid origin and retains its tunnel mode",
  { timeout: 10000 },
  async (t) => {
    const child = await namedService(t, "https://FIXTURE.example:8443/");
    assert.equal(child.message.ready, true);
    assert.equal(child.message.origin, "https://fixture.example:8443");
    const record = readConnectionRecord(child.dir);
    assert.equal(record?.mode.kind, "named");
    assert.deepEqual(record?.mode, {
      kind: "named",
      name: "fixture",
      origin: "https://fixture.example:8443",
      config: join(child.dir, "fixture.yml"),
    });
    assert.equal(existsSync(child.log), true);
  },
);

test("the gateway rejects non-bare origins without changing its active origin", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "loop-host-origin-"));
  const host = createHost(dir);
  t.after(async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  });
  host.setOrigin("https://FIXTURE.example:8443/");
  assert.equal(host.origin, "https://fixture.example:8443");
  for (const origin of [
    "http://fixture.example",
    "https://fixture.example/path",
    "https://fixture.example/?query=1",
    "https://fixture.example/#fragment",
    "https://user:pass@fixture.example",
    "not-a-url",
  ]) {
    assert.throws(() => host.setOrigin(origin), /bare HTTPS origin/);
    assert.equal(host.origin, "https://fixture.example:8443");
  }
});
