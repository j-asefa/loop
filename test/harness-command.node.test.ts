import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarnessCommand } from "../src/harness-command.js";
import { groupAlive } from "../src/daemon.js";

test("harness command retains partial output and nonzero exit diagnostics", async () => {
  await assert.rejects(
    runHarnessCommand(
      process.execPath,
      [
        "-e",
        'process.stdout.write("héllo"); process.stderr.write("detail"); process.exitCode=7;',
      ],
      { cwd: process.cwd(), timeout: 5000, maxBuffer: 1000 },
    ),
    (error: any) => {
      assert.equal(error.stdout, "héllo");
      assert.equal(error.stderr, "detail");
      assert.equal(error.code, 7);
      assert.equal(error.killed, false);
      return true;
    },
  );
});

test("harness command bounds each output stream and marks overflow as interrupted", async () => {
  await assert.rejects(
    runHarnessCommand(
      process.execPath,
      [
        "-e",
        'process.stdout.write("ok"); process.stderr.write("x".repeat(65536)); setInterval(()=>{},1000);',
      ],
      {
        cwd: process.cwd(),
        timeout: 5000,
        maxBuffer: 32,
        killSignal: "SIGKILL",
      },
    ),
    (error: any) => {
      assert.equal(error.stdout, "ok");
      assert.equal(Buffer.byteLength(error.stderr), 32);
      assert.equal(error.killed, true);
      assert.match(error.message, /output exceeded/);
      return true;
    },
  );
});

test(
  "harness command timeout waits for TERM-ignoring process termination",
  { skip: process.platform !== "linux", timeout: 10000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "loop-command-timeout-"));
    const pidFile = join(root, "pid");
    try {
      await assert.rejects(
        runHarnessCommand(
          process.execPath,
          [
            "-e",
            `
      process.on('SIGTERM', ()=>{});
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      setInterval(()=>{},1000);
    `,
            pidFile,
          ],
          { cwd: root, timeout: 500, maxBuffer: 1000 },
        ),
        (error: any) => {
          assert.equal(error.killed, true);
          assert.equal(error.signal, "SIGKILL");
          assert.match(error.message, /timed out/);
          return true;
        },
      );
      assert.equal(groupAlive(Number(readFileSync(pidFile, "utf8"))), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("harness command reports a spawn error without a process id", async () => {
  await assert.rejects(
    runHarnessCommand("/missing-loop-harness-command", [], {
      cwd: process.cwd(),
      timeout: 5000,
      maxBuffer: 100,
    }),
    { code: "ENOENT", stdout: "", stderr: "" },
  );
});

test(
  "harness command does not report success after stopping leftover writers",
  { skip: process.platform !== "linux" },
  async () => {
    await assert.rejects(
      runHarnessCommand(
        process.execPath,
        [
          "-e",
          `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    child.unref();
  `,
        ],
        { cwd: process.cwd(), timeout: 5000, maxBuffer: 1000 },
      ),
      (error: any) => {
        assert.equal(error.killed, true);
        assert.match(error.message, /left running subprocesses/);
        return true;
      },
    );
  },
);
