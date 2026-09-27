import { expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

it("delivers control to exactly the active invocation, validates identity, and does not replay duplicate input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-broker-steering-"));
  cpSync(resolve("runtime"), dir, { recursive: true });
  writeFileSync(
    join(dir, "listen.mjs"),
    `
import { Server } from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function () { this.once('listening', () => process.send({ port: this.address().port })); return listen.call(this, 0, '127.0.0.1'); };
`,
  );
  writeFileSync(
    join(dir, "entry.mjs"),
    `
import { createInterface } from 'node:readline';
let started = false;
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (!started) { started = true; console.log(JSON.stringify({ steeringReady: true })); continue; }
  console.log(JSON.stringify({ chunk: { text: request.text } }));
  console.log(JSON.stringify({ steeringResult: { id: request.id, accepted: true } }));
  if (request.text === 'finish') { console.log(JSON.stringify({ done: true })); process.exit(0); }
}
`,
  );
  const token = "test-broker-steering-token-at-least-32-characters";
  const broker = spawn(
    process.execPath,
    ["--import", join(dir, "listen.mjs"), join(dir, "broker.mjs")],
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
  const controller = new AbortController();
  try {
    const [{ port }] = await once(broker, "message");
    const post = (data: object, authorized = true) =>
      fetch(`http://127.0.0.1:${port}/runtime`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + (authorized ? token : "invalid"),
        },
        body: JSON.stringify({
          key: "a".repeat(64),
          provider: "codex",
          ...data,
        }),
        signal: controller.signal,
      });
    const response = await post({
      action: "turn",
      input: { model: "fixture", messages: [], controlId: "current" },
    });
    let output = "";
    const drained = (async () => {
      for await (const bytes of response.body!)
        output += Buffer.from(bytes).toString();
    })();
    await expect.poll(() => output).toContain('"steeringReady":true');
    const followup = {
      action: "steer",
      controlId: "current",
      id: "followup",
      text: "focus on tests",
    };
    expect((await post(followup, false)).status).toBe(401);
    expect((await post({ ...followup, key: "b".repeat(64) })).status).toBe(409);
    expect((await post({ ...followup, controlId: "previous" })).status).toBe(
      409,
    );
    expect((await post({ ...followup, provider: "claude" })).status).toBe(409);
    expect(await (await post(followup)).json()).toEqual({ accepted: true });
    expect(await (await post(followup)).json()).toEqual({ accepted: true });
    expect((await post({ ...followup, text: "different content" })).ok).toBe(
      false,
    );
    await post({ ...followup, id: "finish", text: "finish" });
    await drained;
    expect(output.match(/focus on tests/g)).toHaveLength(1);
    expect(output).toContain('"done":true');
    expect(output).not.toContain('"error"');
    expect((await post({ ...followup, id: "too-late" })).status).toBe(409);
  } finally {
    controller.abort();
    const closed = once(broker, "close");
    broker.kill("SIGTERM");
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
