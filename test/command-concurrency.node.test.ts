import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runSupervised } from "../scripts/heavy-command.mjs";

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    assert.ok(
      Date.now() < deadline,
      "command did not reach its synchronization point",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  "test, browser and typecheck entrypoints run concurrently despite an unavailable queue and an occupied legacy slot",
  { skip: process.platform !== "linux" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "loop55-command-concurrency-"));
    const children: ChildProcess[] = [];
    try {
      const locks = join(root, "loop55-typecheck");
      mkdirSync(locks, { mode: 0o700 });
      const held = join(root, "held");
      const holder = spawn(
        "python3",
        [
          "-c",
          "import fcntl,sys,time; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); open(sys.argv[2],'w').close(); time.sleep(60)",
          join(locks, "slot.lock"),
          held,
        ],
        { stdio: "ignore" },
      );
      children.push(holder);
      await waitFor(() => existsSync(held));

      // All commands must reach the barrier before any one can finish. No timing
      // assumption about compiler speed or the host's memory is needed.
      const release = join(root, "release");
      const fixture = `import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync(process.env.LOOP55_TEST_STARTED, String(process.pid));
      while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20));`;
      mkdirSync(join(root, "scripts"));
      cpSync(
        new URL("../deployment", import.meta.url),
        join(root, "deployment"),
        { recursive: true },
      );
      for (const name of [
        "heavy-command.mjs",
        "heavy-supervisor.py",
        "typecheck.mjs",
      ])
        cpSync(
          new URL(`../scripts/${name}`, import.meta.url),
          join(root, "scripts", name),
        );
      mkdirSync(join(root, "node_modules/typescript"), { recursive: true });
      mkdirSync(join(root, "node_modules/vitest"), { recursive: true });
      writeFileSync(
        join(root, "node_modules/typescript/package.json"),
        JSON.stringify({
          name: "typescript",
          type: "module",
          main: "compiler.mjs",
          bin: { tsc: "compiler.mjs" },
        }),
      );
      writeFileSync(
        join(root, "node_modules/typescript/compiler.mjs"),
        fixture,
      );
      writeFileSync(join(root, "node_modules/vitest/vitest.mjs"), fixture);
      writeFileSync(join(root, "browser.mjs"), fixture);

      const commands = [
        [
          fileURLToPath(new URL("../scripts/test-runner.mjs", import.meta.url)),
          "vitest",
        ],
        [join(root, "scripts/typecheck.mjs")],
        [join(root, "scripts/heavy-command.mjs"), join(root, "browser.mjs")],
      ];
      const markers = commands.map((_, index) =>
        join(root, `started-${index}`),
      );
      let errors = "";
      const jobs = commands.map((args, index) => {
        const child = spawn(process.execPath, args, {
          cwd: root,
          env: {
            ...process.env,
            XDG_RUNTIME_DIR: root,
            LOOP55_TEST_STARTED: markers[index],
            LOOP55_HEAVY_WAIT_SECONDS: "0",
            LOOP55_HEAVY_RESERVE_MB: "1099511627776",
            LOOP55_HEAVY_SCHEDULING: "on",
            LOOP55_JOB_QUEUE_CONFIG: join(root, "unavailable-queue.json"),
            LOOP55_JOB_ACTIVE: "",
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr.on("data", (data) => {
          errors += data;
        });
        children.push(child);
        return child;
      });
      await waitFor(
        () =>
          markers.every(existsSync) ||
          jobs.some((job) => job.exitCode !== null),
      );
      assert.ok(markers.every(existsSync), errors);
      assert.ok(
        jobs.every((job) => job.exitCode === null),
        "each command is still running concurrently",
      );
      assert.equal(holder.exitCode, null, "the legacy slot is still held");
      writeFileSync(release, "");
      await waitFor(() => jobs.every((job) => job.exitCode !== null));
      assert.deepEqual(
        jobs.map((job) => job.exitCode),
        [0, 0, 0],
        errors,
      );
      holder.kill("SIGTERM");
      await waitFor(
        () => holder.signalCode !== null || holder.exitCode !== null,
      );
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
      await waitFor(() =>
        children.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("command status and cancellation remain observable without admission", async () => {
  const options = { stdio: "ignore" as const, log: () => {} };
  assert.equal(
    await runSupervised(process.execPath, ["-e", "process.exit(7)"], options),
    7,
  );
  assert.equal(
    await runSupervised("/no-such-loop55-command", [], options),
    127,
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await runSupervised(
      process.execPath,
      ["-e", "throw new Error('must not start')"],
      { ...options, signal: controller.signal },
    ),
    130,
  );
});

test(
  "cancelling one concurrent command cleans it up without stopping its sibling",
  { skip: process.platform !== "linux" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "loop55-command-cancel-"));
    const controllers = [new AbortController(), new AbortController()];
    const jobs = controllers.map((controller, i) =>
      runSupervised(
        process.execPath,
        [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(join(root, `${i}.pid`))}, String(process.pid)); setInterval(() => {}, 1000);`,
        ],
        { signal: controller.signal, stdio: "ignore", log: () => {} },
      ),
    );
    try {
      await waitFor(() =>
        [0, 1].every((i) => existsSync(join(root, `${i}.pid`))),
      );
      const pids = [0, 1].map((i) =>
        Number(readFileSync(join(root, `${i}.pid`), "utf8")),
      );
      controllers[0].abort();
      assert.equal(await jobs[0], 143);
      assert.throws(() => process.kill(pids[0], 0));
      assert.doesNotThrow(() => process.kill(pids[1], 0));
      controllers[1].abort();
      assert.equal(await jobs[1], 143);
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(jobs);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
