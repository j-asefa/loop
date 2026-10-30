import { expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

it("delivers control to exactly the active invocation, validates identity, and does not replay duplicate input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop55-broker-steering-"));
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
    join(dir, "entry.ts"),
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
    ["--import", join(dir, "listen.mjs"), join(dir, "broker.ts")],
    {
      env: {
        ...process.env,
        LOOP55_RUNTIME_MODE: "host",
        LOOP55_RUNTIME_WORKDIR: dir,
        LOOP55_RUNTIME_TOKEN: token,
        LOOP55_RUNTIME_TOKEN_FILE: "",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const controller = new AbortController();
  let cleanupInbox = async () => {};
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
          provider: "claude",
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
    expect((await post({ ...followup, provider: "codex" })).status).toBe(409);
    expect(await (await post(followup)).json()).toEqual({ accepted: true });
    expect(await (await post(followup)).json()).toEqual({ accepted: true });
    expect((await post({ ...followup, text: "different content" })).ok).toBe(
      false,
    );
    // Exercise the production inbox against this same broker. Freezing the
    // recovery interval proves a committed steering event drives delivery.
    vi.stubEnv("LOOP55_DATA_DIR", join(dir, "database"));
    const { db, changes } = await import("../src/server/db");
    const { enqueue, claim, transition } = await import("../src/server/queue");
    const { SteeringInbox, saveSteering } =
      await import("../src/server/steering");
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('thread','owner','Steering',1)",
    ).run();
    const queued = enqueue("owner", "Wait", "broker-input", {
      conversation: "thread",
    });
    const run = claim("broker-input")!;
    expect(run.id).toBe(queued.id);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stopInbox = new SteeringInbox(run).listen(
      async (message, inputId) => {
        const response = await post({
          ...followup,
          id: inputId,
          text: message.content,
        });
        expect(await response.json()).toEqual({ accepted: true });
      },
    );
    cleanupInbox = async () => {
      await stopInbox();
      changes.close();
      db.close();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    };
    const sent = saveSteering(
      run,
      "signal-input",
      "signal-input",
      "signal input",
      {},
    );
    await expect
      .poll(
        () =>
          db
            .prepare("SELECT state FROM run_steering WHERE id=?")
            .get(sent.steeringId),
        { timeout: 700 },
      )
      .toEqual({ state: "delivered" });
    expect(output.match(/signal input/g)).toHaveLength(1);
    await stopInbox();
    transition(run, "completed");
    await post({ ...followup, id: "finish", text: "finish" });
    await drained;
    expect(output.match(/focus on tests/g)).toHaveLength(1);
    expect(output).toContain('"done":true');
    expect(output).not.toContain('"error"');
    expect((await post({ ...followup, id: "too-late" })).status).toBe(409);
  } finally {
    await cleanupInbox();
    controller.abort();
    const closed = once(broker, "close");
    broker.kill("SIGTERM");
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
