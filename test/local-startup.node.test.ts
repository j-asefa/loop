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
import { exited, processState, type Recorded } from "../src/process-records.js";

const startup = new URL("../src/local-startup.ts", import.meta.url).href;
const records = new URL("../src/process-records.ts", import.meta.url).href;
const execArgv = ["--import", import.meta.resolve("tsx")];

async function stopFixture(dir: string, signal: NodeJS.Signals = "SIGKILL") {
  const file = join(dir, "owner.json");
  if (!existsSync(file)) return;
  const record: Recorded = JSON.parse(readFileSync(file, "utf8"));
  const state = processState(record);
  assert.notEqual(
    state,
    "unknown",
    "fixture identity must be confirmed before signalling",
  );
  if (state === "running") {
    if (signal === "SIGKILL") killFixtureProcess(record.pid);
    else process.kill(record.pid, signal);
    assert(
      await exited(record.pid, 5000),
      "fixture child exits during cleanup",
    );
  }
  await rm(file);
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "loop-ready-"));
  const entry = join(dir, "child.mjs");
  const log = join(dir, "daemon.log");
  await writeFile(
    entry,
    `
import { reportReady, isEntrypoint } from ${JSON.stringify(startup)};
import { writeFileSync, renameSync } from "node:fs";
import { identity } from ${JSON.stringify(records)};
if (isEntrypoint(import.meta.url)) {
  const [mode, dir] = process.argv.slice(2);
  const mark = (name, value) => writeFileSync(dir + "/" + name, String(value));
  console.log("fixture log");
  process.on("SIGTERM", () => { mark("terminated", "SIGTERM"); process.exit(0); });
  process.on("disconnect", () => mark("disconnected", "yes"));
  const owner = JSON.stringify({ pid: process.pid, identity: identity(process.pid) });
  writeFileSync(dir + "/owner.tmp", owner);
  renameSync(dir + "/owner.tmp", dir + "/owner.json");
  if (mode === "exit") process.exit(7);
  if (mode === "error") reportReady({ error: "Fixture refused", code: "FIXTURE_BUSY" });
  else if (mode === "ready") reportReady({ ready: true, pid: process.pid, cwd: process.cwd(), marker: process.env.FIXTURE_READY_MARKER });
  setInterval(() => {}, 1000);
}
`,
  );
  t.after(async () => {
    await stopFixture(dir);
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
  await stopFixture(dir, "SIGTERM");
  assert.equal(await readFile(join(dir, "terminated"), "utf8"), "SIGTERM");
  const imported = await promisify(execFile)(process.execPath, [
    ...execArgv,
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(entry).href)})`,
  ]);
  assert.equal(imported.stdout, "");
  assert.equal(
    existsSync(join(dir, "owner.json")),
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
  await stopFixture(f.dir);
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
  await stopFixture(f.dir);
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
  await until(() => existsSync(join(dir, "owner.json")));
  parent.kill("SIGINT");
  assert.equal((await exit)[0], 0);
  assert.match(output, /child exit 0/);
  assert.equal(await readFile(join(dir, "terminated"), "utf8"), "SIGTERM");
});

test("CLI entrypoint policy still runs a loaded entry after its path disappears", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "loop-removed-entry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, "removed.mjs");
  await writeFile(
    entry,
    `
import { isEntrypoint } from ${JSON.stringify(startup)};
import { unlinkSync } from "node:fs";
unlinkSync(new URL(import.meta.url));
console.log(JSON.stringify({
  cli: isEntrypoint(import.meta.url, { unresolved: "lexical" }),
  connection: isEntrypoint(import.meta.url),
}));
`,
  );
  const result = await promisify(execFile)(process.execPath, [
    ...execArgv,
    entry,
  ]);
  assert.deepEqual(JSON.parse(result.stdout), { cli: true, connection: false });
  assert.equal(existsSync(entry), false);
});
