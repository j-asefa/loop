import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { workspaceLock, LockBusyError } from "../src/process-records.js";
import { CONNECTION_LOCK } from "../src/connection.js";
import { testWait } from "../src/test-seams.js";

test(
  "connection startup reports lock contention with a machine-readable outcome",
  { timeout: 10000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "loop-startup-outcome-"));
    const release = workspaceLock(dir, CONNECTION_LOCK);
    t.after(async () => {
      release();
      await rm(dir, { recursive: true, force: true });
    });
    assert.throws(
      () =>
        workspaceLock(dir, {
          ...CONNECTION_LOCK,
          owner: "Fixture wording without the old matching phrase",
        }),
      LockBusyError,
    );
    const child = spawn(
      process.execPath,
      [resolve("dist/connection-daemon.js"), "--dir", dir, "--root", dir],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill("SIGKILL");
      await exited;
    });
    const [message] = await once(child, "message");
    assert.equal(message.code, LockBusyError.code);
    assert.equal(typeof message.error, "string");
    assert.equal(message.ready, undefined);
    assert.equal((await exited)[0], 1);
  },
);

test("lifecycle waits accept positive integer overrides and reject invalid values", (t) => {
  const name = "LOOP_TEST_STOP_WAIT_MS";
  const priorStop = process.env[name];
  const priorConnection = process.env.LOOP_TEST_CONNECTION_WAIT_MS;
  t.after(() => {
    if (priorStop === undefined) delete process.env[name];
    else process.env[name] = priorStop;
    if (priorConnection === undefined)
      delete process.env.LOOP_TEST_CONNECTION_WAIT_MS;
    else process.env.LOOP_TEST_CONNECTION_WAIT_MS = priorConnection;
  });
  for (const value of ["", "0", "-1", "1.5", "invalid", "Infinity"]) {
    process.env[name] = value;
    assert.equal(testWait(name), 20000);
  }
  process.env[name] = "37";
  assert.equal(testWait(name), 37);
  delete process.env.LOOP_TEST_CONNECTION_WAIT_MS;
  assert.equal(testWait("LOOP_TEST_CONNECTION_WAIT_MS"), 180000);
});
