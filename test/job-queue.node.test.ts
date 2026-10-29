import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runQueuedJob,
  queueStatus,
  queueCommand,
  taskState,
  cancelQueuedJob,
  type JobConfiguration,
} from "../deployment/job-client.mjs";
import { classifyCommand, shimScript } from "../deployment/job-shim.mjs";
import { runSupervised } from "../scripts/heavy-command.mjs";
import { spawnNative } from "../src/native-spawn.js";
import {
  runQueuedJob as runLegacyJob,
  cancelQueuedJob as cancelLegacyJob,
} from "./fixtures/job-client-v1.mjs";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeout = 15000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}
const binary = process.env.LOOP_TEST_PUEUE;
const daemonBinary = process.env.LOOP_TEST_PUEUED;
const quiet = { stdio: "ignore" as const, log: () => {} };

test("command shims preserve ordinary commands and classify old and current Loop checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-job-classify-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "loop", repository: "github:j-asefa/loop" }),
    );
    assert.equal(
      classifyCommand("npm", ["run", "smoke:design"], dir).label,
      "smoke:design",
    );
    assert.equal(
      classifyCommand("node", ["scripts/typecheck.mjs"], dir).label,
      "typecheck",
    );
    writeFileSync(
      join(dir, "scripts/heavy-command.mjs"),
      "import { runQueuedJob } from '../deployment/job-client.mjs';",
    );
    assert.equal(
      classifyCommand("npm", ["run", "smoke:design"], dir).label,
      undefined,
    );
    assert.equal(
      classifyCommand("node", ["scripts/typecheck.mjs"], dir).label,
      undefined,
    );
    assert.equal(
      classifyCommand("node", ["scripts/design-scenario.mjs", "models"], dir)
        .label,
      "browser check",
    );
    assert.equal(
      classifyCommand(
        "node",
        ["--import", "tsx", "scripts/fixture-server.ts"],
        dir,
      ).label,
      undefined,
    );
    assert.equal(
      classifyCommand("npm", ["view", "typescript", "version"], dir).label,
      undefined,
    );
    assert.equal(classifyCommand("node", ["--version"], dir).label, undefined);
    assert.equal(
      classifyCommand("npx", ["--help", "tsc"], dir).label,
      undefined,
    );
    for (const pattern of ["--watch", "--version", "-pattern"]) {
      assert.equal(
        classifyCommand(
          "node",
          ["--test", "--test-name-pattern", pattern, "fixture.test.mjs"],
          dir,
        ).label,
        "native tests",
      );
      assert.equal(
        classifyCommand(
          "npx",
          ["vitest", "run", "--testNamePattern", pattern],
          dir,
        ).label,
        "vitest check",
      );
    }
    assert.equal(
      classifyCommand("npx", ["tsc", "--noEmit"], dir).label,
      "tsc check",
    );
    const original = ["-e", "console.log('literal browser tests')"];
    assert.deepEqual(classifyCommand("node", original, dir).args, original);
    assert.equal(classifyCommand("node", original, dir).label, undefined);
    assert.equal(
      classifyCommand("npm", ["--prefix", "/other", "run", "build"], dir).label,
      "build",
    );
    assert.equal(
      classifyCommand(
        "npx",
        ["--package", "typescript", "tsc", "--noEmit"],
        dir,
      ).label,
      "tsc check",
    );
    assert.equal(
      classifyCommand("node", ["elsewhere/browser-signin.mjs"], dir).label,
      undefined,
    );
    assert.equal(
      classifyCommand("node", ["app.mjs", "--test"], dir).label,
      undefined,
    );
    for (const options of [
      ["--test-reporter", "spec"],
      ["--test-name-pattern", "selected"],
      ["--test-reporter-destination", "stdout"],
      ["--env-file-if-exists", "fixture.env"],
      ["--max-http-header-size", "16384"],
    ]) {
      assert.equal(
        classifyCommand("node", [...options, "--test", "fixture.test.mjs"], dir)
          .label,
        "native tests",
      );
      assert.equal(
        classifyCommand("node", [...options, "app.mjs", "--test"], dir).label,
        undefined,
      );
    }
    for (const [program, args] of [
      ["npx", ["vite"]],
      ["npx", ["vite", "preview"]],
      ["npx", ["tsc", "--watch"]],
      ["npx", ["--yes", "--", "tsc", "--watch"]],
      ["npx", ["vitest"]],
      ["npx", ["vitest", "run", "--watch"]],
      ["npx", ["playwright", "test", "--ui"]],
      ["npm", ["exec", "vite"]],
      ["npm", ["run", "build", "--", "--watch"]],
      ["node", ["--test", "--watch", "fixture.test.mjs"]],
      ["node", ["--test", "--watch-path=false", "fixture.test.mjs"]],
    ] as const) {
      assert.equal(
        classifyCommand(program, [...args], dir, { ci: false, tty: true })
          .label,
        undefined,
      );
    }
    for (const options of [
      ["--config", "vite.config.ts"],
      ["--mode", "production"],
      ["-m", "production"],
      ["--logLevel", "warn"],
      ["-l", "warn"],
      ["--configLoader", "native"],
      ["--debug", "vite:config"],
      ["-d", "vite:config"],
      ["--profile", "build-profile"],
      ["--assetsDir", "assets"],
      ["--assetsInlineLimit", "4096"],
      ["--minify", "oxc"],
      ["--sourcemap", "hidden"],
    ]) {
      assert.equal(
        classifyCommand("npx", ["vite", ...options, "build"], dir).label,
        "vite check",
      );
    }
    for (const options of [["--profile"], ["--sourcemap"], ["--minify"]]) {
      assert.equal(
        classifyCommand("npx", ["vite", "build", ...options, "--watch"], dir)
          .label,
        undefined,
      );
    }
    assert.equal(
      classifyCommand("npx", ["vite", "--open", "build"], dir).label,
      undefined,
    );
    for (const context of [
      { ci: true, tty: true },
      { ci: false, tty: false },
    ]) {
      assert.equal(
        classifyCommand("npx", ["vitest"], dir, context).label,
        "vitest check",
      );
      assert.equal(
        classifyCommand(
          "node",
          ["node_modules/vitest/vitest.mjs"],
          dir,
          context,
        ).label,
        "tests",
      );
      assert.equal(
        classifyCommand("npm", ["exec", "--", "vitest"], dir, context).label,
        "vitest check",
      );
      assert.equal(
        classifyCommand("npx", ["vitest", "--watch"], dir, context).label,
        undefined,
      );
    }
    assert.equal(
      classifyCommand("npx", ["vite", "build"], dir).label,
      "vite check",
    );
    assert.equal(
      classifyCommand("npx", ["vitest", "run"], dir).label,
      "vitest check",
    );
    assert.equal(
      classifyCommand("npm", ["exec", "--", "tsc", "--noEmit"], dir).label,
      "tsc check",
    );
    for (const selection of [
      ["--workspace", "frontend"],
      ["-w", "frontend"],
      ["--prefix", "/other"],
    ]) {
      for (const tool of ["vite", "vitest", "tsc"]) {
        const command =
          tool === "vite"
            ? [tool, "build"]
            : tool === "vitest"
              ? [tool, "run"]
              : [tool, "--noEmit"];
        for (const args of [
          ["exec", ...selection, "--", ...command],
          [...selection, "exec", "--", ...command],
        ]) {
          assert.equal(
            classifyCommand("npm", args, dir).label,
            tool + " check",
          );
        }
      }
      assert.equal(
        classifyCommand(
          "npm",
          ["exec", ...selection, "--", "vite", "preview"],
          dir,
        ).label,
        undefined,
      );
    }
    assert.equal(
      classifyCommand("node", ["-e", "console.log('ok')", "--", "--test"], dir)
        .label,
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary commands retain the native PID and extra protocol descriptors through the host shim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-job-fds-"));
  const savedShims = process.env.LOOP_JOB_SHIMS;
  try {
    const shim = join(dir, "node");
    // Ordinary harness startup does not depend on queue availability.
    writeFileSync(
      shim,
      shimScript(
        join(dir, "missing.json"),
        process.execPath,
        resolve("deployment/job-shim.mjs"),
        "node",
        process.execPath,
      ),
      { mode: 0o700 },
    );
    process.env.LOOP_JOB_SHIMS = dir;
    const child = spawnNative(
      "node",
      [
        "-e",
        "require('fs').writeSync(3, String(process.pid)); process.exit(7)",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe"] },
    );
    let protocol = "",
      errors = "";
    (child.stdio[3] as import("node:stream").Readable).on(
      "data",
      (data) => (protocol += data),
    );
    child.stderr!.on("data", (data) => (errors += data));
    const [code] = await once(child, "close");
    assert.equal(code, 7, errors);
    assert.equal(Number(protocol), child.pid);
  } finally {
    if (savedShims === undefined) delete process.env.LOOP_JOB_SHIMS;
    else process.env.LOOP_JOB_SHIMS = savedShims;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Node test options cannot bypass a configured unavailable queue through the host shim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-job-node-options-"));
  try {
    const shim = join(dir, "node"),
      marker = join(dir, "must-not-run"),
      fixture = join(dir, "fixture.test.mjs");
    writeFileSync(
      shim,
      shimScript(
        join(dir, "missing.json"),
        process.execPath,
        resolve("deployment/job-shim.mjs"),
        "node",
        process.execPath,
      ),
      { mode: 0o700 },
    );
    writeFileSync(
      fixture,
      "import {writeFileSync} from 'node:fs';writeFileSync(" +
        JSON.stringify(marker) +
        ",'bad');",
    );
    for (const args of [
      ["--test-reporter", "spec", "--test", fixture],
      ...["--watch", "--version", "-pattern"].map((pattern) => [
        "--test",
        "--test-name-pattern",
        pattern,
        fixture,
      ]),
    ]) {
      const child = spawn(shim, args, { stdio: "ignore" });
      const [code] = await once(child, "close");
      assert.equal(code, 125);
      assert.equal(existsSync(marker), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package manager options and implicit CI Vitest runs cannot bypass an unavailable queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-job-tool-options-"));
  try {
    const marker = join(dir, "must-not-run"),
      command = join(dir, "underlying");
    writeFileSync(command, "#!/bin/sh\ntouch '" + marker + "'\n", {
      mode: 0o700,
    });
    for (const program of ["npx", "node", "npm"] as const) {
      const shim = join(dir, program);
      writeFileSync(
        shim,
        shimScript(
          join(dir, "missing.json"),
          process.execPath,
          resolve("deployment/job-shim.mjs"),
          program,
          command,
        ),
        { mode: 0o700 },
      );
      const cases =
        program === "npx"
          ? [
              ["vite", "--config", "vite.config.ts", "build"],
              ["vite", "--mode", "production", "build"],
              ["vitest"],
            ]
          : program === "node"
            ? [["node_modules/vitest/vitest.mjs"]]
            : [
                ["exec", "--workspace", "frontend", "--", "vite", "build"],
                ["exec", "-w", "frontend", "--", "vitest", "run"],
              ];
      for (const args of cases) {
        const child = spawn(shim, args, {
          stdio: "ignore",
          env: { ...process.env, CI: "true" },
        });
        const [code] = await once(child, "close");
        assert.equal(code, 125);
        assert.equal(existsSync(marker), false);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bounded compiler still rejects real TypeScript errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-job-types-"));
  try {
    writeFileSync(
      join(dir, "bad.ts"),
      "const answer: number = 'not a number';\n",
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { types: [], skipLibCheck: true },
        files: ["bad.ts"],
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/typecheck.mjs", "--project", join(dir, "tsconfig.json")],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /TS2322/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a configured unavailable queue never falls back to an unscheduled check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-job-offline-"));
  const saved = process.env.LOOP_JOB_QUEUE_CONFIG;
  const active = process.env.LOOP_JOB_ACTIVE;
  try {
    const config = join(dir, "config.json"),
      marker = join(dir, "must-not-start");
    writeFileSync(
      config,
      JSON.stringify({
        pueue: join(dir, "missing"),
        config: join(dir, "pueue.yml"),
        jobs: join(dir, "jobs"),
        group: "loop-heavy",
      }),
    );
    process.env.LOOP_JOB_QUEUE_CONFIG = config;
    // The test itself may already be admitted by the host's queue. Exercise
    // submission failure independently, then the supervisor's invalid-config
    // path with no inherited admission marker.
    await assert.rejects(
      runQueuedJob(process.execPath, ["-e", "process.exit(0)"], quiet),
    );
    process.env.LOOP_JOB_QUEUE_CONFIG = join(dir, "missing-config.json");
    delete process.env.LOOP_JOB_ACTIVE;
    const code = await runSupervised(
      process.execPath,
      [
        "-e",
        "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'bad')",
      ],
      { ...quiet, job: true },
    );
    assert.equal(code, 125);
    assert.equal(existsSync(marker), false);
  } finally {
    if (saved === undefined) delete process.env.LOOP_JOB_QUEUE_CONFIG;
    else process.env.LOOP_JOB_QUEUE_CONFIG = saved;
    if (active === undefined) delete process.env.LOOP_JOB_ACTIVE;
    else process.env.LOOP_JOB_ACTIVE = active;
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "real Pueue queue preserves execution ownership and makes progress after failures",
  { skip: !binary || !daemonBinary, timeout: 120000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-job-real-"));
    const saved = process.env.LOOP_JOB_QUEUE_CONFIG;
    const config: JobConfiguration = {
      pueue: binary!,
      config: join(dir, "pueue.yml"),
      jobs: join(dir, "controls"),
      group: "loop-heavy",
      commands: { node: process.execPath },
    };
    const configPath = join(dir, "jobs.json"),
      state = join(dir, "state"),
      runtime = join(dir, "runtime");
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(runtime, { mode: 0o700 });
    writeFileSync(
      config.config,
      JSON.stringify({
        shared: { pueue_directory: state, runtime_directory: runtime },
        daemon: { pause_group_on_failure: false, pause_all_on_failure: false },
      }),
      { mode: 0o600 },
    );
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    process.env.LOOP_JOB_QUEUE_CONFIG = configPath;
    let daemon: ChildProcess;
    async function start() {
      daemon = spawn(daemonBinary!, ["--config", config.config], {
        stdio: "ignore",
        env: { PATH: process.env.PATH },
      });
      await until(async () => {
        try {
          await queueStatus(config);
          return true;
        } catch {
          return false;
        }
      }, "fixture daemon ready");
    }
    await start();
    await queueCommand(config, [
      "group",
      "add",
      "--parallel",
      "1",
      config.group,
    ]);
    const run = (
      code: string,
      options: Parameters<typeof runQueuedJob>[2] = {},
    ) => runQueuedJob(process.execPath, ["-e", code], { ...quiet, ...options });
    try {
      await t.test(
        "independent callers share one queue and failed jobs release capacity",
        async () => {
          const file = join(dir, "order");
          const program = (id: number, exit: number) =>
            "const fs=require('fs');fs.appendFileSync(" +
            JSON.stringify(file) +
            "," +
            JSON.stringify("start" + id + "\n") +
            ");setTimeout(()=>{fs.appendFileSync(" +
            JSON.stringify(file) +
            "," +
            JSON.stringify("end" + id + "\n") +
            ");process.exit(" +
            exit +
            ")},150);";
          const first = run(program(1, 7));
          await until(() => existsSync(file), "first job started");
          const second = run(program(2, 0));
          assert.deepEqual(await Promise.all([first, second]), [7, 0]);
          assert.deepEqual(readFileSync(file, "utf8").trim().split("\n"), [
            "start1",
            "end1",
            "start2",
            "end2",
          ]);
        },
      );
      await t.test(
        "argv and credential environment are not persisted by the queue",
        async () => {
          const secret = "fixture-credential-not-for-queue-state";
          const marker = join(dir, "arguments"),
            gate = join(dir, "argument-gate");
          const cwd = join(dir, "cwd ' with spaces");
          mkdirSync(cwd);
          const code =
            "const fs=require('fs');fs.writeFileSync(" +
            JSON.stringify(marker) +
            ",JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),secret:process.env.FIXTURE_SECRET}));const timer=setInterval(()=>{if(fs.existsSync(" +
            JSON.stringify(gate) +
            ")){clearInterval(timer);process.exit(0)}},30)";
          const task = runQueuedJob(
            process.execPath,
            ["-e", code, "literal $(exit 5) ' quoted"],
            {
              ...quiet,
              cwd,
              env: { PATH: process.env.PATH, FIXTURE_SECRET: secret },
            },
          );
          await until(() => existsSync(marker), "argument fixture started");
          try {
            const stored = readFileSync(join(state, "state.json"), "utf8");
            assert.equal(stored.includes(secret), false);
            assert.equal(stored.includes("literal $(exit 5)"), false);
            const observed = JSON.parse(readFileSync(marker, "utf8"));
            assert.deepEqual(observed, {
              cwd,
              args: ["literal $(exit 5) ' quoted"],
              secret,
            });
          } finally {
            writeFileSync(gate, "done");
          }
          assert.equal(await task, 0);
        },
      );
      await t.test(
        "cancelling a queued job never dispatches its command",
        async () => {
          const gate = join(dir, "cancel-gate"),
            started = join(dir, "cancel-started"),
            forbidden = join(dir, "forbidden");
          const first = run(
            "const fs=require('fs');fs.writeFileSync(" +
              JSON.stringify(started) +
              ",'1');const t=setInterval(()=>{if(fs.existsSync(" +
              JSON.stringify(gate) +
              ")){clearInterval(t);process.exit(0)}},30)",
          );
          await until(() => existsSync(started), "blocker started");
          const controller = new AbortController();
          const waiting = run(
            "require('fs').writeFileSync(" +
              JSON.stringify(forbidden) +
              ",'bad')",
            { signal: controller.signal },
          );
          await until(
            async () =>
              Object.values((await queueStatus(config)).tasks).filter(
                (x) => taskState(x) !== "Done",
              ).length === 2,
            "second job queued",
          );
          controller.abort();
          try {
            assert.equal(await waiting, 130);
            assert.equal(existsSync(forbidden), false);
          } finally {
            writeFileSync(gate, "done");
          }
          assert.equal(await first, 0);
          assert.equal(existsSync(forbidden), false);
        },
      );
      await t.test(
        "nested checks with a cleaned environment do not queue behind themselves",
        async () => {
          const module = pathToFileURL(
            resolve("scripts/heavy-command.mjs"),
          ).href;
          const code =
            "const {runSupervised}=await import(" +
            JSON.stringify(module) +
            ");process.exitCode=await runSupervised(process.execPath,['-e','process.exit(9)'],{job:true,env:{PATH:process.env.PATH},stdio:'ignore'});";
          assert.equal(
            await runQueuedJob(
              process.execPath,
              ["--input-type=module", "-e", code],
              quiet,
            ),
            9,
          );
        },
      );
      await t.test(
        "an original client can execute and cancel jobs after its shared worker is upgraded",
        async () => {
          writeFileSync(
            configPath,
            JSON.stringify({
              ...config,
              worker: resolve("deployment/job-worker.mjs"),
            }),
          );
          try {
            assert.equal(
              await runLegacyJob(
                process.execPath,
                ["-e", "process.exit(23)"],
                quiet,
              ),
              23,
            );
            const marker = join(dir, "legacy-started");
            const task = runLegacyJob(
              process.execPath,
              [
                "-e",
                "require('fs').writeFileSync(" +
                  JSON.stringify(marker) +
                  ",'started');setInterval(()=>{},1000)",
              ],
              { ...quiet, label: "legacy check fixture" },
            );
            await until(
              () => existsSync(marker),
              "legacy command started through new worker",
            );
            const selected = Object.values(
              (await queueStatus(config)).tasks,
            ).find((task) => task.label?.endsWith(":legacy check fixture"))!;
            const cli = spawn(
              process.execPath,
              [
                resolve("deployment/job-cli.mjs"),
                "cancel",
                selected.label!.split(":")[1],
              ],
              { stdio: "ignore" },
            );
            const [code] = await once(cli, "close");
            assert.equal(code, 0);
            assert.equal(await task, 143);
          } finally {
            writeFileSync(configPath, JSON.stringify(config));
          }
        },
      );
      await t.test(
        "an original operator can cancel a current job without receiving its signing key",
        async () => {
          const marker = join(dir, "old-operator-started");
          const controller = new AbortController();
          const task = run(
            "require('fs').writeFileSync(" +
              JSON.stringify(marker) +
              ",'started');setInterval(()=>{},1000)",
            { label: "old operator fixture", signal: controller.signal },
          );
          try {
            await until(
              () => existsSync(marker),
              "current job started for old operator",
            );
            const selected = Object.values(
              (await queueStatus(config)).tasks,
            ).find((task) => task.label?.endsWith(":old operator fixture"))!;
            const identity = selected.label!.split(":")[1];
            const control = JSON.parse(
              readFileSync(
                join(config.jobs, "job-" + identity, "control.json"),
                "utf8",
              ),
            );
            assert.notEqual(control.key, control.secret);
            await cancelLegacyJob(config, identity);
            assert.equal(await task, 143);
          } finally {
            controller.abort();
            await task;
          }
        },
      );
      await t.test(
        "source clients use their matching worker across installed protocol generations",
        async () => {
          writeFileSync(
            configPath,
            JSON.stringify({
              ...config,
              worker: join(dir, "old-install/job-worker.mjs"),
            }),
          );
          try {
            assert.equal(await run("process.exit(19)"), 19);
          } finally {
            writeFileSync(configPath, JSON.stringify(config));
          }
        },
      );
      await t.test(
        "nested explicit jobs finish in the parent's slot and preserve status",
        async () => {
          const cli = resolve("deployment/job-cli.mjs");
          for (const clean of [false, true]) {
            const code =
              "const r=require('child_process').spawnSync(process.execPath," +
              JSON.stringify([
                cli,
                "run",
                "--",
                process.execPath,
                "-e",
                "process.exit(17)",
              ]) +
              ",{stdio:'ignore',timeout:5000" +
              (clean
                ? ",env:{PATH:process.env.PATH,LOOP_JOB_QUEUE_CONFIG:process.env.LOOP_JOB_QUEUE_CONFIG}"
                : "") +
              "});process.exit(r.status ?? 99)";
            assert.equal(await run(code), 17);
          }
        },
      );
      await t.test(
        "running cancellation cleans up before the next command starts",
        async () => {
          const marker = join(dir, "running-cancel");
          const controller = new AbortController();
          const task = run(
            "require('fs').writeFileSync(" +
              JSON.stringify(marker) +
              ",String(process.pid));setInterval(()=>{},1000)",
            { signal: controller.signal },
          );
          await until(() => existsSync(marker), "cancel fixture started");
          controller.abort();
          assert.equal(await task, 130);
          const pid = Number(readFileSync(marker, "utf8"));
          assert.throws(() => process.kill(pid, 0));
          assert.equal(await run("process.exit(0)"), 0);
        },
      );
      await t.test(
        "operator cancellation binds to one invocation even when Pueue reuses a task ID",
        async () => {
          const marker = join(dir, "operator-started");
          const task = run(
            "require('fs').writeFileSync(" +
              JSON.stringify(marker) +
              ",'started');setInterval(()=>{},1000)",
          );
          await until(() => existsSync(marker), "operator fixture started");
          const state = await queueStatus(config);
          const selected = Object.values(state.tasks).find(
            (x) => taskState(x) === "Running",
          )!;
          const identity = selected.label!.split(":")[1];
          const cli = spawn(
            process.execPath,
            [resolve("deployment/job-cli.mjs"), "cancel", identity],
            { stdio: "ignore" },
          );
          const [code] = await once(cli, "close");
          assert.equal(code, 0);
          assert.equal(await task, 143);
          const next = run("setTimeout(()=>process.exit(0),500)");
          await assert.rejects(
            cancelQueuedJob(config, identity),
            /no longer waiting or running/,
          );
          assert.equal(await next, 0);
        },
      );
      await t.test(
        "the caller receives all output from a fast completed job",
        async () => {
          const client = pathToFileURL(
            resolve("deployment/job-client.mjs"),
          ).href;
          const program =
            "for(let i=0;i<4000;i++)console.log('line-'+i+'-'.repeat(50)); console.log('last-output-marker')";
          const caller = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              "const {runQueuedJob}=await import(" +
                JSON.stringify(client) +
                ");process.exitCode=await runQueuedJob(process.execPath,['-e'," +
                JSON.stringify(program) +
                "],{log:()=>{}});",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let output = "",
            errors = "";
          caller.stdout.on("data", (data) => (output += data));
          caller.stderr.on("data", (data) => (errors += data));
          const [code] = await once(caller, "close");
          assert.equal(code, 0, errors);
          const lines = output.trimEnd().split("\n");
          assert.equal(lines.length, 4001);
          assert.equal(lines.at(-1), "last-output-marker");
        },
      );
      await t.test(
        "slow output consumers receive complete diagnostics before task removal",
        async () => {
          const client = pathToFileURL(
            resolve("deployment/job-client.mjs"),
          ).href;
          const marker = join(dir, "slow-output-completed");
          const expected = "x".repeat(2 * 1024 * 1024) + "last-output-marker\n";
          const program =
            "process.stdout.write('x'.repeat(2*1024*1024)+'last-output-marker\\n');require('fs').writeFileSync(" +
            JSON.stringify(marker) +
            ",'done')";
          const caller = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              "const {runQueuedJob}=await import(" +
                JSON.stringify(client) +
                ");process.exitCode=await runQueuedJob(process.execPath,['-e'," +
                JSON.stringify(program) +
                "],{log:()=>{}});",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let output = "",
            errors = "";
          caller.stdout.pause();
          caller.stderr.on("data", (chunk) => (errors += chunk));
          const closed = once(caller, "close");
          try {
            await until(
              () => existsSync(marker),
              "slow output command completed",
            );
            await delay(3000);
            assert.equal(
              caller.exitCode,
              null,
              "caller waits for downstream output",
            );
            caller.stdout.on("data", (chunk) => (output += chunk));
            caller.stdout.resume();
            const [code] = await closed;
            assert.equal(code, 0, errors);
            assert.equal(output, expected);
          } finally {
            if (caller.exitCode === null && !caller.signalCode)
              caller.kill("SIGTERM");
            caller.stdout.resume();
            await closed;
          }
        },
      );
      await t.test(
        "cancelling output drain preserves cancellation status and saved logs",
        async () => {
          const client = pathToFileURL(
            resolve("deployment/job-client.mjs"),
          ).href;
          const marker = join(dir, "cancel-output-completed");
          const program =
            "process.stdout.write('x'.repeat(2*1024*1024));require('fs').writeFileSync(" +
            JSON.stringify(marker) +
            ",'done')";
          const caller = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              "const {runQueuedJob}=await import(" +
                JSON.stringify(client) +
                ");process.exitCode=await runQueuedJob(process.execPath,['-e'," +
                JSON.stringify(program) +
                "],{log:()=>{}});",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          caller.stdout.pause();
          caller.stderr.resume();
          const closed = once(caller, "close");
          try {
            await until(
              () => existsSync(marker),
              "cancel output command completed",
            );
            await delay(3000);
            caller.kill("SIGTERM");
            caller.stdout.resume();
            const [code] = await closed;
            assert.equal(code, 143);
          } finally {
            if (caller.exitCode === null && !caller.signalCode)
              caller.kill("SIGTERM");
            caller.stdout.resume();
            await closed;
          }
        },
      );
      await t.test(
        "operator cancellation remains available until output has drained",
        async () => {
          const client = pathToFileURL(
            resolve("deployment/job-client.mjs"),
          ).href;
          const marker = join(dir, "operator-output-completed");
          const program =
            "process.stdout.write('x'.repeat(2*1024*1024));require('fs').writeFileSync(" +
            JSON.stringify(marker) +
            ",'done')";
          const caller = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              "const {runQueuedJob}=await import(" +
                JSON.stringify(client) +
                ");process.exitCode=await runQueuedJob(process.execPath,['-e'," +
                JSON.stringify(program) +
                "],{label:'operator drain fixture',log:()=>{}});",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          caller.stdout.pause();
          caller.stderr.resume();
          const closed = once(caller, "close");
          try {
            await until(
              () => existsSync(marker),
              "operator output command completed",
            );
            let identity = "";
            await until(async () => {
              const task = Object.values(
                (await queueStatus(config)).tasks,
              ).find((task) => task.label?.endsWith(":operator drain fixture"));
              if (!task || taskState(task) !== "Done") return false;
              identity = task.label!.split(":")[1];
              return true;
            }, "operator job is draining completed output");
            await delay(750);
            const cli = spawn(
              process.execPath,
              [resolve("deployment/job-cli.mjs"), "cancel", identity],
              { stdio: "ignore" },
            );
            const [cancelCode] = await once(cli, "close");
            assert.equal(cancelCode, 0);
            caller.stdout.resume();
            const [code] = await closed;
            assert.equal(code, 143);
            assert.ok(
              Object.values((await queueStatus(config)).tasks).some((task) =>
                task.label?.includes(identity),
              ),
              "interrupted diagnostics remain available",
            );
          } finally {
            if (caller.exitCode === null && !caller.signalCode)
              caller.kill("SIGTERM");
            caller.stdout.resume();
            await closed;
          }
        },
      );
      await t.test(
        "a failed output follower retains completed diagnostics",
        async () => {
          const wrapper = join(dir, "failed-follower");
          writeFileSync(
            wrapper,
            "#!" +
              process.execPath +
              "\n" +
              "const {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args.includes('follow'))process.exit(7);const r=spawnSync(" +
              JSON.stringify(binary) +
              ",args,{stdio:'inherit'});process.exit(r.status ?? 125);",
            { mode: 0o700 },
          );
          const messages: string[] = [];
          writeFileSync(
            configPath,
            JSON.stringify({ ...config, pueue: wrapper }),
          );
          try {
            assert.equal(
              await run("console.log('retained diagnostics')", {
                log: (line) => messages.push(line),
              }),
              0,
            );
            const tasks = Object.values((await queueStatus(config)).tasks);
            assert.ok(tasks.some((task) => taskState(task) === "Done"));
            assert.ok(
              messages.some((line) => line.includes("logs were retained")),
            );
          } finally {
            writeFileSync(configPath, JSON.stringify(config));
          }
        },
      );
      await t.test(
        "host shims do not deadlock when a nested fixture removes the active-job marker",
        async () => {
          const shims = join(dir, "bin");
          mkdirSync(shims);
          writeFileSync(
            join(shims, "node"),
            shimScript(
              configPath,
              process.execPath,
              resolve("deployment/job-shim.mjs"),
              "node",
              process.execPath,
            ),
            { mode: 0o700 },
          );
          const fixture = join(dir, "fixture.test.mjs");
          writeFileSync(
            fixture,
            "import test from 'node:test'; test('fixture',()=>{});",
          );
          const clean = { PATH: shims + ":" + process.env.PATH };
          const code =
            "const r=require('child_process').spawnSync('node',['--test'," +
            JSON.stringify(fixture) +
            "],{env:" +
            JSON.stringify(clean) +
            ",stdio:'ignore',timeout:7000});process.exit(r.status ?? 99)";
          assert.equal(await run(code), 0);
        },
      );
      await t.test(
        "original installed shims recognize a source worker without Linux cgroup admission",
        async () => {
          const installed = join(dir, "installed/deployment"),
            shims = join(dir, "installed-bin");
          mkdirSync(installed, { recursive: true });
          mkdirSync(shims);
          for (const name of [
            "job-worker.mjs",
            "job-protocol.mjs",
            "job-peer.mjs",
          ])
            cpSync(resolve("deployment", name), join(installed, name));
          cpSync(
            resolve("test/fixtures/job-client-v1.mjs"),
            join(installed, "job-client.mjs"),
          );
          cpSync(
            resolve("test/fixtures/job-shim-v1.mjs"),
            join(installed, "job-shim.mjs"),
          );
          writeFileSync(
            configPath,
            JSON.stringify({
              ...config,
              worker: join(installed, "job-worker.mjs"),
            }),
          );
          writeFileSync(
            join(shims, "node"),
            shimScript(
              configPath,
              process.execPath,
              join(installed, "job-shim.mjs"),
              "node",
              process.execPath,
            ),
            { mode: 0o700 },
          );
          // Simulate the macOS ownership path in this child only; no cgroup
          // shortcut and no active-job environment marker may admit it.
          const platform = join(dir, "non-linux.mjs"),
            fixture = join(dir, "cross-generation.test.mjs");
          writeFileSync(
            platform,
            "Object.defineProperty(process,'platform',{value:'darwin'});",
          );
          writeFileSync(
            fixture,
            "import test from 'node:test';test('nested fixture',()=>{});",
          );
          const clean = {
            PATH: shims + ":" + process.env.PATH,
            NODE_OPTIONS: "--import=" + platform,
          };
          const code =
            "const r=require('child_process').spawnSync('node',['--test'," +
            JSON.stringify(fixture) +
            "],{env:" +
            JSON.stringify(clean) +
            ",stdio:'ignore',timeout:5000});process.exit(r.status ?? 99)";
          try {
            assert.equal(await run(code), 0);
          } finally {
            writeFileSync(configPath, JSON.stringify(config));
          }
        },
      );
      await t.test(
        "caller death stops detached descendants and leaves the next job runnable",
        { skip: process.platform !== "linux" },
        async () => {
          const marker = join(dir, "orphan-pid");
          const grandchild =
            "require('fs').writeFileSync(" +
            JSON.stringify(marker) +
            ",String(process.pid));setInterval(()=>{},1000)";
          const program =
            "require('child_process').spawn(process.execPath,['-e'," +
            JSON.stringify(grandchild) +
            "],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)";
          const client = pathToFileURL(
            resolve("deployment/job-client.mjs"),
          ).href;
          const caller = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              "const {runQueuedJob}=await import(" +
                JSON.stringify(client) +
                ");await runQueuedJob(process.execPath,['-e'," +
                JSON.stringify(program) +
                "],{stdio:'ignore',log:()=>{}});",
            ],
            { env: process.env, stdio: "ignore" },
          );
          try {
            await until(() => existsSync(marker), "orphan fixture started");
            const pid = Number(readFileSync(marker, "utf8"));
            caller.kill("SIGKILL");
            await once(caller, "close");
            await until(() => {
              try {
                process.kill(pid, 0);
                return false;
              } catch {
                return true;
              }
            }, "detached child reaped");
            assert.equal(await run("process.exit(0)"), 0);
          } finally {
            if (caller.exitCode === null && !caller.signalCode)
              caller.kill("SIGKILL");
          }
        },
      );
      await t.test(
        "daemon loss fails the invocation without replay, and restart recovers the queue",
        async () => {
          const marker = join(dir, "attempts");
          const task = run(
            "require('fs').appendFileSync(" +
              JSON.stringify(marker) +
              ",'once\\n');setInterval(()=>{},1000)",
          ).catch(() => 125);
          await until(() => existsSync(marker), "restart fixture started");
          const closed = once(daemon, "close");
          daemon.kill("SIGKILL");
          await closed;
          assert.equal(await task, 125);
          await start();
          assert.equal(await run("process.exit(0)"), 0);
          assert.equal(readFileSync(marker, "utf8"), "once\n");
        },
      );
      await until(
        () => !existsSync(config.jobs) || readdirSync(config.jobs).length === 0,
        "rendezvous files cleaned",
      );
    } finally {
      await queueCommand(config, ["shutdown"]).catch(() => {});
      if (daemon!.exitCode === null && !daemon!.signalCode) {
        const closed = once(daemon!, "close");
        daemon!.kill("SIGTERM");
        await closed;
      }
      if (saved === undefined) delete process.env.LOOP_JOB_QUEUE_CONFIG;
      else process.env.LOOP_JOB_QUEUE_CONFIG = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
