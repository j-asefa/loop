import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnReady } from "../src/local-startup.js";
import { until, killFixtureProcess } from "./helpers.js";
import { exited } from "../src/process-records.js";

const startup = new URL("../src/local-startup.ts", import.meta.url).href;
const execArgv = ["--import", import.meta.resolve("tsx")];

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "loop-ready-"));
  const entry = join(dir, "child.mjs");
  const log = join(dir, "daemon.log");
  await writeFile(
    entry,
    `
import { reportReady, isEntrypoint } from ${JSON.stringify(startup)};
import { writeFileSync } from "node:fs";
if (isEntrypoint(import.meta.url)) {
  const [mode, dir] = process.argv.slice(2);
  const mark = (name, value) => writeFileSync(dir + "/" + name, String(value));
  mark("pid", process.pid);
  console.log("fixture log");
  process.on("SIGTERM", () => { mark("terminated", "SIGTERM"); process.exit(0); });
  process.on("disconnect", () => mark("disconnected", "yes"));
  if (mode === "exit") process.exit(7);
  if (mode === "error") reportReady({ error: "Fixture refused", code: "FIXTURE_BUSY" });
  else if (mode === "ready") reportReady({ ready: true, pid: process.pid, cwd: process.cwd(), marker: process.env.FIXTURE_READY_MARKER });
  setInterval(() => {}, 1000);
}
`,
  );
  t.after(async () => {
    const pidFile = join(dir, "pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      killFixtureProcess(pid);
      assert(await exited(pid, 5000), "fixture child exits during cleanup");
    }
    await rm(dir, { recursive: true, force: true });
  });
  const options = {
    execArgv,
    cwd: dir,
    env: { ...process.env, FIXTURE_READY_MARKER: "present" },
    timeout: 5000,
    timeoutMessage: "Fixture startup timed out",
    exitMessage: (code: number | null) => "Fixture exited " + code,
    readMessage: (message: any) => {
      if (message?.ready) return message;
      throw new Error(message?.error || "Fixture failed");
    },
  };
  return { dir, entry, log, options };
}

test("detached readiness preserves payload, log, environment and symlink entrypoint", async (t) => {
  const { dir, entry, log, options } = await fixture(t);
  const link = join(dir, "linked.mjs");
  await symlink(entry, link);
  const ready = await spawnReady(link, ["ready", dir], log, options);
  assert.equal(ready.ready, true);
  assert.equal(ready.cwd, dir);
  assert.equal(ready.marker, "present");
  await until(() => existsSync(join(dir, "disconnected")));
  assert.match(await readFile(log, "utf8"), /fixture log/);
  assert.equal(
    process.kill(ready.pid, 0),
    true,
    "ready child stays alive after IPC disconnect",
  );
  process.kill(ready.pid, "SIGTERM");
  await until(() => existsSync(join(dir, "terminated")));
  assert(await exited(ready.pid, 5000));
  await rm(join(dir, "pid"));
  const imported = await promisify(execFile)(process.execPath, [
    ...execArgv,
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(entry).href)})`,
  ]);
  assert.equal(imported.stdout, "");
  assert.equal(
    existsSync(join(dir, "pid")),
    false,
    "importing the entry does not launch it",
  );
});

test("detached startup preserves rejection details and caller-decoded busy outcomes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    spawnReady(f.entry, ["error", f.dir], f.log, f.options),
    /Fixture refused/,
  );
  const first = Number(await readFile(join(f.dir, "pid"), "utf8"));
  killFixtureProcess(first);
  assert(await exited(first, 5000));
  const message = await spawnReady(f.entry, ["error", f.dir], f.log, {
    ...f.options,
    readMessage: (value: any) => value,
  });
  assert.deepEqual(message, { error: "Fixture refused", code: "FIXTURE_BUSY" });
});

test("detached startup settles early exit and terminates a timed-out child", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    spawnReady(f.entry, ["exit", f.dir], f.log, f.options),
    /Fixture exited 7/,
  );
  await assert.rejects(
    spawnReady(f.entry, ["hang", f.dir], f.log, {
      ...f.options,
      timeout: 1500,
    }),
    /Fixture startup timed out/,
  );
  await until(() => existsSync(join(f.dir, "terminated")));
  assert(
    await exited(Number(await readFile(join(f.dir, "pid"), "utf8")), 5000),
  );
});

test("a startup parent forwards interruption to its detached child", async (t) => {
  const { dir, entry, log } = await fixture(t);
  const parentFile = join(dir, "parent.mjs");
  await writeFile(
    parentFile,
    `
import { spawnReady } from ${JSON.stringify(startup)};
try {
  await spawnReady(${JSON.stringify(entry)}, ["hang", ${JSON.stringify(dir)}], ${JSON.stringify(log)}, {
    execArgv: ${JSON.stringify(execArgv)}, forwardSignals: true, timeout: 10000,
    timeoutMessage: "timed out", exitMessage: code => "child exit " + code, readMessage: value => value,
  });
} catch (error) { console.log(error.message); }
`,
  );
  const parent = spawn(process.execPath, [...execArgv, parentFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = once(parent, "exit");
  t.after(async () => {
    parent.kill("SIGKILL");
    await exit;
  });
  let output = "";
  parent.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await until(() => existsSync(join(dir, "pid")));
  parent.kill("SIGINT");
  assert.equal((await exit)[0], 0);
  assert.match(output, /child exit 0/);
  assert.equal(await readFile(join(dir, "terminated"), "utf8"), "SIGTERM");
});
