import { expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { MAX_CONCURRENT_RUNS } from "../runtime/concurrency.ts";

it("the broker enforces capacity and releases it on disconnect", async () => {
  expect(MAX_CONCURRENT_RUNS).toBe(32);
  const fixtureCapacity = 2;
  const dir = mkdtempSync(join(tmpdir(), "loop-broker-capacity-"));
  cpSync(resolve("runtime"), dir, { recursive: true });
  // Keep the production broker path, but bound this process-heavy fixture.
  writeFileSync(
    join(dir, "concurrency.ts"),
    `export const MAX_CONCURRENT_RUNS = ${fixtureCapacity};\n`,
  );
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
  // Real broker and child processes; no model requests, Docker or accounts.
  writeFileSync(
    join(dir, "entry.mjs"),
    `
for await (const chunk of process.stdin) {}
console.log(JSON.stringify({ chunk: { text: 'holding' } }));
setInterval(() => {}, 1000);
`,
  );
  const token = "fixture-broker-capacity-token-at-least-32-characters";
  const broker = spawn(
    process.execPath,
    ["--import", join(dir, "port.mjs"), join(dir, "broker.mjs")],
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
  const controllers: AbortController[] = [];
  const drains: Promise<void>[] = [];
  let started = 0;
  try {
    const [{ port }] = await once(broker, "message");
    const request = (n: number, provider = "claude") => {
      const controller = new AbortController();
      controllers.push(controller);
      return fetch(`http://127.0.0.1:${port}/runtime`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          key: n.toString(16).padStart(64, "0"),
          provider,
          action: "turn",
          input: { model: "fixture", messages: [] },
        }),
        signal: controller.signal,
      });
    };
    const hold = async (n: number) => {
      const response = await request(n);
      let settled!: (started: boolean) => void;
      const ready = new Promise<boolean>((resolve) => {
        settled = resolve;
      });
      drains.push(
        (async () => {
          let output = "";
          for await (const bytes of response.body!) {
            const wasStarted = output.includes("holding");
            output += Buffer.from(bytes).toString();
            if (!wasStarted && output.includes("holding")) {
              started++;
              settled(true);
            }
          }
          settled(false);
        })().catch(() => {
          settled(false);
        }),
      );
      return ready;
    };
    for (let n = 1; n <= fixtureCapacity; n++) await hold(n);
    await expect.poll(() => started, { timeout: 10_000 }).toBe(fixtureCapacity);
    // Both providers share the same capacity.
    const overflow = await (await request(fixtureCapacity + 1)).text();
    expect(JSON.parse(overflow)).toHaveProperty("error");
    expect(overflow).not.toContain("holding");
    const codexOverflow = await request(fixtureCapacity + 2, "codex");
    expect(codexOverflow.status).toBe(409);
    expect((await codexOverflow.json()).error).toContain("capacity");
    controllers[0].abort();
    await drains[0];
    // Closing the HTTP stream cancels the child asynchronously.
    let retry = fixtureCapacity + 3;
    await expect.poll(() => hold(retry++), { timeout: 5000 }).toBe(true);
    expect(started).toBe(fixtureCapacity + 1);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.all(drains);
    const closed = once(broker, "close");
    broker.kill("SIGTERM");
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
