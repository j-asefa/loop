import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
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
import { after, test } from "node:test";
import { withHeavySlot } from "../scripts/heavy-command.mjs";

const directory = mkdtempSync(join(tmpdir(), "loop-heavy-test-"));
const lockFile = join(directory, "slot.lock");
const moduleUrl = new URL("../scripts/heavy-command.mjs", import.meta.url).href;
const options = {
  lockFile,
  reserveMiB: 0,
  stdio: "ignore" as const,
  log: () => {},
};
const linux = process.platform === "linux";
const processes: ChildProcess[] = [];
after(() => {
  for (const child of processes)
    if (child.pid && child.exitCode === null && !child.signalCode)
      child.kill("SIGTERM");
  rmSync(directory, { force: true, recursive: true });
});

test("the design entrypoint preserves the first failure when cancelling siblings", async () => {
  const project = join(directory, "design-project");
  mkdirSync(project);
  writeFileSync(
    join(project, "design-browser-smoke.mjs"),
    readFileSync(
      new URL("../scripts/design-browser-smoke.mjs", import.meta.url),
    ),
  );
  writeFileSync(
    join(project, "heavy-command.mjs"),
    `
    import { appendFileSync } from 'node:fs';
    export async function withHeavySlot(_command, args, { signal }) {
      appendFileSync('started', args[1] + '\\n');
      if (args[1] === 'models') return new Promise(resolve => setTimeout(() => resolve(Number(process.env.LOOP_TEST_STATUS)), 50));
      if (signal.aborted) return 143;
      return new Promise(resolve => signal.addEventListener('abort', () => resolve(143), { once: true }));
    }
  `,
  );
  for (const expected of [75, 7]) {
    writeFileSync(join(project, "started"), "");
    const runner = spawn(
      process.execPath,
      ["design-browser-smoke.mjs", "models", "clear-search", "core"],
      {
        cwd: project,
        env: {
          ...process.env,
          LOOP_BROWSER_WORKERS: "2",
          LOOP_TEST_STATUS: String(expected),
        },
        stdio: "ignore",
      },
    );
    processes.push(runner);
    const code = await new Promise((resolve) => runner.once("close", resolve));
    assert.equal(code, expected);
    assert.deepEqual(
      readFileSync(join(project, "started"), "utf8").trim().split("\n"),
      ["models", "clear-search"],
    );
  }
});

test(
  "the test entrypoint preserves admission while removing live settings",
  { skip: !linux },
  async () => {
    const project = join(directory, "test-project");
    mkdirSync(join(project, "node_modules/vitest"), { recursive: true });
    writeFileSync(
      join(project, "node_modules/vitest/vitest.mjs"),
      `
    import { writeFileSync } from "node:fs";
    writeFileSync("observed.json", JSON.stringify({ profile: process.env.LOOP_PROFILE,
      live: process.env.LOOP_DATA_DIR, keep: process.env.LOOP_TEST_KEEP,
      reservation: process.env.LOOP_HEAVY_SLOT, args: process.argv.slice(2) }));
  `,
    );
    const runner = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/test-runner.mjs", import.meta.url)),
        "vitest",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: join(project, "runtime"),
          LOOP_HEAVY_RESERVE_MB: "0",
          LOOP_DATA_DIR: "must-not-reach-tests",
          LOOP_TEST_KEEP: "yes",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    processes.push(runner);
    let output = "",
      error = "";
    runner.stdout.on("data", (data) => {
      output += data;
    });
    runner.stderr.on("data", (data) => {
      error += data;
    });
    const code = await new Promise((resolve) => runner.once("close", resolve));
    assert.equal(code, 0, error);
    assert.ok(
      existsSync(join(project, "observed.json")),
      JSON.stringify({ error, output }),
    );
    const observed = JSON.parse(
      readFileSync(join(project, "observed.json"), "utf8"),
    );
    assert.equal(observed.profile, "server");
    assert.equal(observed.live, undefined);
    assert.equal(observed.keep, "yes");
    assert.equal(JSON.parse(observed.reservation).length, 3);
    assert.equal(observed.args[0], "run");
    for (const [index, extra] of [
      ["--watch=true"],
      ["--watch=false"],
      ["--watch", "false"],
    ].entries()) {
      const runtime = join(project, `watch-runtime-${index}`);
      const checked = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../scripts/test-runner.mjs", import.meta.url)),
          "vitest",
          ...extra,
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            XDG_RUNTIME_DIR: runtime,
            LOOP_HEAVY_RESERVE_MB: "0",
          },
          encoding: "utf8",
        },
      );
      assert.equal(checked.status, 0, checked.stderr);
      assert.equal(
        existsSync(join(runtime, "loop-typecheck")),
        index !== 0,
        `${extra.join(" ")} admission`,
      );
    }
  },
);

test(
  "zero reserve skips an unavailable probe and reaping uses Python 3.8 APIs",
  { skip: !linux },
  () => {
    const source = fileURLToPath(
      new URL("../scripts/heavy-supervisor.py", import.meta.url),
    );
    const config = {
      label: "zero reserve",
      lock: lockFile,
      parentPid: process.pid,
      waitSeconds: 0,
      reserveMiB: 0,
    };
    const checked = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("supervisor", ${JSON.stringify(source)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def unavailable(*args, **kwargs):
    raise PermissionError("unavailable on this host")
module.memory_headroom = unavailable
module.os.waitstatus_to_exitcode = unavailable
sys.argv = ["supervisor", ${JSON.stringify(JSON.stringify(config))}, ${JSON.stringify(process.execPath)}, "-e", "process.exit(7)"]
sys.exit(module.main())
`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 7, checked.stderr);
  },
);

test(
  "memory admission respects ancestor ceilings and reclaimable cache",
  { skip: !linux },
  () => {
    const source = fileURLToPath(
      new URL("../scripts/heavy-supervisor.py", import.meta.url),
    );
    const checked = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        `
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
spec = importlib.util.spec_from_file_location("supervisor", ${JSON.stringify(source)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def python39_only(*args, **kwargs):
    raise AttributeError("is_relative_to is unavailable on Python 3.8")
Path.is_relative_to = python39_only
with TemporaryDirectory() as directory:
    base = Path(directory)
    proc, root = base / "proc", base / "cgroup"
    (proc / "self").mkdir(parents=True)
    (proc / "meminfo").write_text("MemAvailable: 100 kB\\n")
    (proc / "self/cgroup").write_text("0::/agents/job\\n")
    job = root / "agents/job"
    job.mkdir(parents=True)
    (job / "memory.max").write_text("max")
    parent = job.parent
    (parent / "memory.max").write_text("1000")
    (parent / "memory.current").write_text("900")
    (parent / "memory.stat").write_text("inactive_file 300\\nfile_dirty 50\\nfile_writeback 20\\n")
    assert module.memory_headroom(proc, root) == 330
    (parent / "memory.stat").write_text("inactive_file 0\\n")
    assert module.memory_headroom(proc, root) == 100
    (job / "memory.max").write_text("500")
    (job / "memory.current").write_text("490")
    (job / "memory.stat").write_text("inactive_file 0\\n")
    assert module.memory_headroom(proc, root) == 10
    (proc / "meminfo").write_text("MemAvailable: 0 kB\\n")
    assert module.memory_headroom(proc, root) == 0
`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr);
  },
);

async function waitFor(
  condition: () => boolean,
  message: string,
  timeout = 12000,
) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function locked() {
  return (
    spawnSync(
      "python3",
      [
        "-c",
        "import fcntl,sys; fcntl.flock(open(sys.argv[1], 'a'), fcntl.LOCK_EX | fcntl.LOCK_NB)",
        lockFile,
      ],
      { stdio: "ignore" },
    ).status !== 0
  );
}

function wrapper(code: string, extra: Record<string, unknown> = {}) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { withHeavySlot } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await withHeavySlot(process.execPath, ["-e", ${JSON.stringify(code)}],
      ${JSON.stringify({ ...options, log: undefined, ...extra })});
  `,
    ],
    { stdio: "ignore" },
  );
  processes.push(child);
  return child;
}

test(
  "memory admission refuses without starting anything",
  { skip: !linux },
  async () => {
    const marker = join(directory, "memory-started");
    const code = await withHeavySlot(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`],
      {
        ...options,
        waitSeconds: 0,
        reserveMiB: 2 ** 40,
      },
    );
    assert.equal(code, 75);
    assert.equal(existsSync(marker), false);
    assert.equal(locked(), false);
  },
);

test(
  "nested build/check invocations reuse their ancestor's reservation",
  { skip: !linux },
  async () => {
    const code = `import { withHeavySlot } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await withHeavySlot(process.execPath, ['-e', 'process.exit(7)'],
      ${JSON.stringify({ ...options, log: undefined, waitSeconds: 0 })});`;
    assert.equal(
      await withHeavySlot(
        process.execPath,
        ["--input-type=module", "-e", code],
        options,
      ),
      7,
    );
    assert.equal(locked(), false);
  },
);

test(
  "an orphaned detached browser is killed before the slot is released",
  { skip: !linux },
  async () => {
    const marker = join(directory, "orphan.pid");
    const childCode = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const job = wrapper(`
    const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { detached: true, stdio: 'ignore' });
    child.unref();
    const timer = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(marker)})) { clearInterval(timer); process.exit(0); } }, 10);
  `);
    await waitFor(() => existsSync(marker), "browser started");
    const pid = Number(readFileSync(marker, "utf8"));
    assert.ok(locked(), "orphan still reserves capacity");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(alive(pid));
    assert.ok(locked());
    await waitFor(
      () => job.exitCode !== null,
      "supervisor waited for orphan cleanup",
    );
    assert.equal(job.exitCode, 0);
    assert.equal(alive(pid), false);
    assert.equal(locked(), false);
  },
);

test(
  "cancelling a queued wrapper never starts its command later",
  { skip: !linux },
  async () => {
    const marker = join(directory, "holder.pid");
    const held = wrapper(
      `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    await waitFor(() => existsSync(marker), "holder started");
    const unwanted = join(directory, "cancelled-started");
    const waiting = wrapper(
      `require('fs').writeFileSync(${JSON.stringify(unwanted)}, '');`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    waiting.kill("SIGTERM");
    await waitFor(
      () => waiting.exitCode !== null || waiting.signalCode !== null,
      "waiting caller cancelled",
    );
    held.kill("SIGTERM");
    await waitFor(() => held.exitCode !== null, "holder stopped");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(unwanted), false);
    assert.equal(locked(), false);
  },
);

test(
  "SIGKILL of the JS caller cleans up its active subtree",
  { skip: !linux },
  async () => {
    const marker = join(directory, "killed.pid");
    const job = wrapper(
      `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    await waitFor(() => existsSync(marker), "command started");
    const pid = Number(readFileSync(marker, "utf8"));
    job.kill("SIGKILL");
    await waitFor(
      () => !alive(pid) && !locked(),
      "supervisor cleaned the orphan before releasing capacity",
    );
  },
);
