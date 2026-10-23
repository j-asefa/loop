import { TURN_IDLE_MS } from "../runtime/idle-deadline.ts";
import { expect, it } from "vitest";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

it("kills a stalled broker process despite heartbeats and releases the next queued turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-broker-idle-"));
  cpSync(resolve("runtime"), dir, { recursive: true });
  // Run the real broker over HTTP with real child processes. Only provider
  // execution and the clock scale are fixtures; queueing/cleanup stay real.
  writeFileSync(
    join(dir, "clock.mjs"),
    `
import { Server } from 'node:http';
const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === ${TURN_IDLE_MS} ? 1000 : ms, ...args);
globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 15000 ? 20 : ms, ...args);
const listen = Server.prototype.listen;
Server.prototype.listen = function () {
  this.once('listening', () => process.send({ port: this.address().port }));
  return listen.call(this, 0, '127.0.0.1');
};
`,
  );
  writeFileSync(
    join(dir, "entry.mjs"),
    `
import { spawn } from 'node:child_process';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
if (request.input.model === 'stall') {
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  console.log(JSON.stringify({ pid: process.pid, childPid: child.pid }));
  setInterval(() => console.log(JSON.stringify({ heartbeat: true })), 20);
} else {
  console.log(JSON.stringify({ chunk: { text: 'queued turn completed' } }));
  console.log(JSON.stringify({ done: true }));
}
`,
  );
  const token = "test-broker-token-with-at-least-32-characters";
  const broker = spawn(
    process.execPath,
    ["--import", join(dir, "clock.mjs"), join(dir, "broker.mjs")],
    {
      env: {
        ...process.env,
        LOOP_RUNTIME_MODE: "host",
        LOOP_RUNTIME_WORKDIR: dir,
        LOOP_RUNTIME_TOKEN: token,
        LOOP_RUNTIME_TOKEN_FILE: "",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let pid: number | undefined;
  let childPid: number | undefined;
  try {
    const [{ port }] = await once(broker, "message");
    const request = (model: string) =>
      fetch(`http://127.0.0.1:${port}/runtime`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          key: "a".repeat(64),
          provider: "claude",
          action: "turn",
          input: { model, messages: [] },
        }),
        signal: AbortSignal.timeout(5000),
      });
    const stalled = await request("stall");
    let output = "";
    const drained = (async () => {
      for await (const bytes of stalled.body!)
        output += Buffer.from(bytes).toString();
    })();
    await expect.poll(() => output).toContain('"pid":');
    pid = JSON.parse(
      output.split("\n").find((line) => line.includes('"pid":'))!,
    ).pid;
    childPid = JSON.parse(
      output.split("\n").find((line) => line.includes('"pid":'))!,
    ).childPid;
    const queued = await request("next");
    let next = "";
    const nextDrained = (async () => {
      for await (const bytes of queued.body!)
        next += Buffer.from(bytes).toString();
    })();
    await expect.poll(() => next).toContain("\n");
    expect(
      next.trim(),
      "queued response must contain only transport keepalives",
    ).toBe("");
    await Promise.all([drained, nextDrained]);
    expect(output).toContain('"heartbeat":true');
    expect(output).toContain("\n\n"); // Actual HTTP keepalives.
    expect(output).toContain('"code":"idle_timeout"');
    expect(output).toContain(
      `no progress for ${TURN_IDLE_MS / 60_000} minutes`,
    );
    expect(() => process.kill(pid!, 0)).toThrow();
    await expect
      .poll(() => {
        try {
          process.kill(childPid!, 0);
          // Linux can retain an orphaned zombie until PID 1 reaps it.
          return (
            process.platform === "linux" &&
            readFileSync(`/proc/${childPid}/stat`, "utf8")
              .split(") ")[1]
              .startsWith("Z")
          );
        } catch (error) {
          return ["ESRCH", "ENOENT"].includes(
            (error as NodeJS.ErrnoException).code!,
          );
        }
      })
      .toBe(true);
    expect(next).toContain("queued turn completed");
    expect(next).not.toContain('"error"');
  } finally {
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    const closed = once(broker, "close");
    broker.kill("SIGKILL");
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
