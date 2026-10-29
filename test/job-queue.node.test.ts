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
