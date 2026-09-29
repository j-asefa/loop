import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

it.each(["claude", "codex"])(
  "waits for idle %s work and excludes new work during cleanup",
  async (provider) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-broker-cleanup-"));
    cpSync(resolve("runtime"), join(dir, "runtime"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
    writeFileSync(join(dir, "runtime", "package.json"), '{"type":"module"}');
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "calls"), "");
    // Real broker HTTP/queues/child processes. Only Docker/provider execution is
    // replaced; filesystem cleanup is covered with real Git in its own suite.
    writeFileSync(
      join(dir, "port.mjs"),
      `
import { Server } from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function () {
  this.once('listening', () => process.send({ port: this.address().port }));
  return listen.call(this, 0, '127.0.0.1');
};
`,
    );
    writeFileSync(
      join(dir, "bin", "docker"),
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
if (process.argv[2] !== 'run') process.exit(0);
const shared = process.argv.at(-1).endsWith('codex-worker.mjs');
const log = (action) => appendFileSync(process.env.CLEANUP_CALLS, action + '\\n');
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const m = JSON.parse(line), request = shared ? m.request : m;
  if (!request) return;
  const send = event => console.log(JSON.stringify(shared ? { id: m.id, event } : event));
  log(request.action + ':start');
  if (request.action === 'turn') send({ chunk: { text: 'running fixture' } });
  setTimeout(() => {
    log(request.action + ':end');
    if (request.action === 'turn') send({ done: true });
    else send({ result: { results: [{ retired: true }] } });
    if (shared) send({ finished: true });
    else process.exit(0);
  }, request.action === 'turn' ? 1800 : 350);
});
`,
      { mode: 0o755 },
    );
    const token = "test-cleanup-broker-token-with-32-characters";
    const broker = spawn(
      process.execPath,
      ["--import", join(dir, "port.mjs"), join(dir, "runtime", "broker.mjs")],
      {
        env: {
          ...process.env,
          PATH: join(dir, "bin") + ":" + process.env.PATH,
          LOOP_RUNTIME_MODE: "docker",
          LOOP_RUNTIME_TOKEN: token,
          LOOP_RUNTIME_TOKEN_FILE: "",
          CLEANUP_CALLS: join(dir, "calls"),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    try {
      const [{ port }] = await once(broker, "message");
      const call = (action: string, extra = {}) =>
        fetch(`http://127.0.0.1:${port}/runtime`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            key: "a".repeat(64),
            provider,
            action,
            ...extra,
          }),
          signal: AbortSignal.timeout(10000),
        });
      const turn = {
        input: { model: "fixture", workspaceKey: "b".repeat(64), messages: [] },
      };
      const cleanup = { workspaceKeys: ["b".repeat(64)] };
      const running = await call("turn", turn);
      const finished = running.text();
      await expect
        .poll(() => readFileSync(join(dir, "calls"), "utf8"), { timeout: 5000 })
        .toContain("turn:start");
      expect(await (await call("cleanup", cleanup)).json()).toEqual({
        skipped: true,
      });
      await finished;
      const cleaning = call("cleanup", cleanup);
      await expect
        .poll(() => readFileSync(join(dir, "calls"), "utf8"), { timeout: 5000 })
        .toContain("cleanup:start");
      expect(await (await call("cleanup", cleanup)).json()).toEqual({
        skipped: true,
      });
      const next = await call("turn", turn);
      expect(next.status).toBe(200); // Both providers wait behind cleanup.
      expect(await (await cleaning).json()).toEqual({
        results: [{ retired: true }],
      });
      if (provider === "codex") {
        await expect
          .poll(
            () =>
              readFileSync(join(dir, "calls"), "utf8").split("turn:start")
                .length,
            { timeout: 5000 },
          )
          .toBe(3);
        const read = await call("read-file", {
          workspaceKey: "b".repeat(64),
          path: "result.txt",
        });
        expect(read.status).toBe(200);
        await read.json();
        const duringTurn = readFileSync(join(dir, "calls"), "utf8");
        expect(duringTurn).toContain("read-file:end");
        expect(duringTurn.split("turn:end").length).toBe(2);
      }
      await next.text();
      const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
      expect(calls.slice(0, 4)).toEqual([
        "turn:start",
        "turn:end",
        "cleanup:start",
        "cleanup:end",
      ]);
      expect(calls.slice(4)).toEqual(
        provider === "codex"
          ? ["turn:start", "read-file:start", "read-file:end", "turn:end"]
          : ["turn:start", "turn:end"],
      );
      expect(
        (await call("cleanup", { workspaceKeys: ["../escape"] })).status,
      ).toBe(422);
    } finally {
      const closed = once(broker, "close");
      broker.kill("SIGTERM");
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
