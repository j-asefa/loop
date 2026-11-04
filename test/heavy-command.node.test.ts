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
import { runSupervised } from "../scripts/heavy-command.mjs";

const directory = mkdtempSync(join(tmpdir(), "loop-heavy-test-"));
const moduleUrl = new URL("../scripts/heavy-command.mjs", import.meta.url).href;
const options = {
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
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(project, "runtime"));
  writeFileSync(
    join(project, "scripts", "design-browser-smoke.mjs"),
    readFileSync(
      new URL("../scripts/design-browser-smoke.mjs", import.meta.url),
    ),
  );
  writeFileSync(
    join(project, "scripts", "heavy-command.mjs"),
    `
    import { appendFileSync } from 'node:fs';
    export async function runSupervised(_command, args, { signal }) {
      appendFileSync('started', args[1] + '\\n');
      if (args[1] === 'models') return new Promise(resolve => setTimeout(() => resolve(Number(process.env.LOOP_TEST_STATUS)), 50));
      if (signal.aborted) return 143;
      return new Promise(resolve => signal.addEventListener('abort', () => resolve(143), { once: true }));
    }
  `,
  );
  for (const expected of [1, 7]) {
    writeFileSync(join(project, "started"), "");
    const runner = spawn(
      process.execPath,
      ["scripts/design-browser-smoke.mjs", "models", "clear-search", "core"],
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
  "the test entrypoint strips live settings and accepts watch options",
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
      args: process.argv.slice(2) }));
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
          },
          encoding: "utf8",
        },
      );
      assert.equal(checked.status, 0, checked.stderr);
    }
  },
);

test("subprocess reaping works with Python 3.8 APIs", { skip: !linux }, () => {
  const source = fileURLToPath(
    new URL("../scripts/heavy-supervisor.py", import.meta.url),
  );
  const config = {
    label: "Python 3.8",
    parentPid: process.pid,
    waitSeconds: 0,
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
module.os.waitstatus_to_exitcode = unavailable
sys.argv = ["supervisor", ${JSON.stringify(JSON.stringify(config))}, ${JSON.stringify(process.execPath)}, "-e", "process.exit(7)"]
sys.exit(module.main())
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(checked.status, 7, checked.stderr);
});

test(
  "supervision tolerates disappearing proc tasks while preserving command exit status",
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
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("supervisor", ${JSON.stringify(source)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = module.Path
for exception in (FileNotFoundError, ProcessLookupError):
    for location in ("glob", "read"):
        remaining = [1]
        class VanishingTask:
            def read_text(self):
                raise exception("fixture: process exited before children read")
        class ProcPath:
            def __init__(self, path):
                self.path = original(path)
            def glob(self, pattern):
                # Fail during iteration, as pathlib does when a process exits
                # after its PID was collected but before its tasks are scanned.
                if remaining[0]:
                    remaining[0] -= 1
                    if location == "glob":
                        raise exception("fixture: process exited during glob")
                    yield VanishingTask()
                yield from self.path.glob(pattern)
        module.Path = ProcPath
        config = {"label": "proc exit race", "parentPid": os.getppid()}
        import json
        sys.argv = ["supervisor", json.dumps(config), ${JSON.stringify(process.execPath)}, "-e", "process.exit(7)"]
        assert module.main() == 7, (exception, location)
        assert remaining[0] == 0, "race fixture was not exercised"
`,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(checked.status, 0, checked.stderr);
  },
);

test(
  "an incomplete scan after command exit cannot bypass orphan cleanup",
  { skip: !linux },
  () => {
    const source = fileURLToPath(
      new URL("../scripts/heavy-supervisor.py", import.meta.url),
    );
    const marker = join(directory, "scan-race-orphan");
    const code = `
    const {spawn}=require('node:child_process');
    const {writeFileSync}=require('node:fs');
    const orphan=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
    writeFileSync(${JSON.stringify(marker)},String(orphan.pid));
    orphan.unref();
    process.exit(7);
  `;
    const checked = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        `
import importlib.util, json, os, signal, sys
spec = importlib.util.spec_from_file_location("supervisor", ${JSON.stringify(source)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_path, original_wait = module.Path, module.os.waitpid
reaped, injected = [False], [False]
def waitpid(*args):
    result = original_wait(*args)
    if result[0]: reaped[0] = True
    return result
class ProcPath:
    def __init__(self, path):
        self.path = original_path(path)
    def glob(self, pattern):
        if reaped[0] and not injected[0]:
            injected[0] = True
            raise ProcessLookupError("fixture: incomplete scan after command exit")
        yield from self.path.glob(pattern)
module.Path, module.os.waitpid = ProcPath, waitpid
sys.argv = ["supervisor", json.dumps({"label":"orphan scan race","parentPid":os.getppid()}), ${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(code)}]
try:
    assert module.main() == 7
    assert injected[0], "race fixture was not exercised"
    orphan = int(original_path(${JSON.stringify(marker)}).read_text())
    try:
        os.kill(orphan, 0)
    except ProcessLookupError:
        pass
    else:
        raise AssertionError("supervisor returned while its orphan remained alive")
finally:
    # Keep a failing regression from leaking its own fixture process.
    if original_path(${JSON.stringify(marker)}).exists():
        orphan = int(original_path(${JSON.stringify(marker)}).read_text())
        try: os.kill(orphan, signal.SIGKILL)
        except ProcessLookupError: pass
        try: original_wait(orphan, 0)
        except ChildProcessError: pass
`,
      ],
      { encoding: "utf8", timeout: 15000 },
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
function wrapper(code: string, extra: Record<string, unknown> = {}) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { runSupervised } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await runSupervised(process.execPath, ["-e", ${JSON.stringify(code)}],
      ${JSON.stringify({ ...options, log: undefined, ...extra })});
  `,
    ],
    { stdio: "ignore" },
  );
  processes.push(child);
  return child;
}

test(
  "nested build/check invocations preserve the inner exit status",
  { skip: !linux },
  async () => {
    const code = `import { runSupervised } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await runSupervised(process.execPath, ['-e', 'process.exit(7)'],
      ${JSON.stringify({ ...options, log: undefined })});`;
    assert.equal(
      await runSupervised(
        process.execPath,
        ["--input-type=module", "-e", code],
        options,
      ),
      7,
    );
  },
);

test(
  "an orphaned detached browser is killed before the command resolves",
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(alive(pid));
    await waitFor(
      () => job.exitCode !== null,
      "supervisor waited for orphan cleanup",
    );
    assert.equal(job.exitCode, 0);
    assert.equal(alive(pid), false);
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
    await waitFor(() => !alive(pid), "supervisor cleaned the orphan");
  },
);
