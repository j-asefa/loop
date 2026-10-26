import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SLOT_BUSY_EXIT, privateLockDir, withTypecheckSlot } from "../scripts/typecheck.mjs";

const flock = process.platform === "linux" && spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
const dir = mkdtempSync(join(tmpdir(), "loop-typecheck-slot-"));
const lockFile = join(dir, "slot.lock");
const quiet = { lockFile, reserveMiB: 0, stdio: "ignore" as const, log: () => {} };
const holders: ChildProcess[] = [];
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  // flock's child inherits the locked descriptor, so end the whole group.
  for (const holder of holders.splice(0)) if (holder.pid) try { process.kill(-holder.pid, "SIGKILL"); } catch {}
});

/** Start a process that holds the lock and return once it really owns it. */
async function holdLock(seconds: number) {
  const holder = spawn("flock", [lockFile, "sleep", String(seconds)], { stdio: "ignore", detached: true });
  holders.push(holder);
  const deadline = Date.now() + 5000;
  while (spawnSync("flock", ["-n", lockFile, "true"], { stdio: "ignore" }).status === 0) {
    assert.ok(Date.now() < deadline, "the holder never took the lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("passes the command's exit status through", async () => {
  assert.equal(await withTypecheckSlot(process.execPath, ["-e", "process.exit(0)"], quiet), 0);
  assert.equal(await withTypecheckSlot(process.execPath, ["-e", "process.exit(3)"], quiet), 3);
});

test("the default lock directory is private to this user", { skip: process.platform === "win32" }, () => {
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
  try {
    const lockDir = privateLockDir();
    assert.equal(lockDir, join(dir, "loop-typecheck"));
    const info = statSync(lockDir!);
    assert.equal(info.uid, userInfo().uid);
    assert.equal(info.mode & 0o077, 0);
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
  }
});

test("a missing command resolves to a status instead of throwing", async () => {
  assert.equal(await withTypecheckSlot(join(dir, "no-such-command"), [], quiet), 127);
});

/** Start a wrapper whose command records its pid and then idles. */
async function startIdleWrapper(name: string, options: { lockFile?: string; detached?: boolean } = {}) {
  const pidFile = join(dir, name + ".pid");
  rmSync(pidFile, { force: true });
  const script = `import { withTypecheckSlot } from ${JSON.stringify(new URL("../scripts/typecheck.mjs", import.meta.url).href)};
    process.exitCode = await withTypecheckSlot(process.execPath, ["-e",
      "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)", ${JSON.stringify(pidFile)}],
      { lockFile: ${JSON.stringify(options.lockFile ?? lockFile)}, reserveMiB: 0, stdio: "ignore", log: () => {} });`;
  const wrapper = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: "ignore",
    detached: options.detached ?? false,
  });
  holders.push(wrapper);
  const deadline = Date.now() + 10000;
  while (!existsSync(pidFile)) {
    assert.ok(Date.now() < deadline, "the inner command started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { wrapper, inner: Number(readFileSync(pidFile, "utf8")) };
}

async function assertExits(pid: number, what: string) {
  const gone = Date.now() + 10000;
  while (Date.now() < gone) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(what);
}

test("terminating a wrapper also ends the command it started", { skip: !flock }, async () => {
  const { wrapper, inner } = await startIdleWrapper("term");
  wrapper.kill("SIGTERM");
  await new Promise((resolve) => wrapper.on("close", resolve));
  await assertExits(inner, "the inner command survived the wrapper's termination");
});

test(
  "a wrapper killed outright cancels its compiler before releasing the slot",
  { skip: process.platform !== "linux" },
  async () => {
    const { wrapper, inner } = await startIdleWrapper("orphan");
    wrapper.kill("SIGKILL");
    await new Promise((resolve) => wrapper.on("close", resolve));
    await assertExits(inner, "the orphaned compiler was not cleaned up");
    const deadline = Date.now() + 5000;
    while (
      spawnSync("flock", ["-n", lockFile, "true"], { stdio: "ignore" })
        .status !== 0
    ) {
      assert.ok(
        Date.now() < deadline,
        "the slot frees once the compiler is gone",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
);

test("killing the wrapper's whole process group ends the command too", { skip: !flock }, async () => {
  const { wrapper, inner } = await startIdleWrapper("group", { detached: true });
  process.kill(-wrapper.pid!, "SIGKILL");
  await assertExits(inner, "the inner command survived a kill of its process group");
});

test("the second caller waits for the first and reports it", { skip: !flock }, async () => {
  await holdLock(2);
  const lines: string[] = [];
  const started = Date.now();
  const status = await withTypecheckSlot(process.execPath, ["-e", "process.exit(0)"], {
    ...quiet,
    log: (line: string) => lines.push(line),
  });
  assert.equal(status, 0);
  assert.ok(Date.now() - started >= 1000, "ran only after the holder released the slot");
  assert.match(lines[0], /waiting for the host's heavy-check slot/);
  assert.match(lines[1], /slot acquired after/);
});

test("a slot that never frees exits with the temporary-failure code", { skip: !flock }, async () => {
  await holdLock(30);
  const lines: string[] = [];
  const status = await withTypecheckSlot(
    process.execPath,
    ["-e", "require('fs').writeFileSync(process.argv[1], '')", join(dir, "ran")],
    { ...quiet, waitSeconds: 1, log: (line: string) => lines.push(line) },
  );
  assert.equal(status, SLOT_BUSY_EXIT);
  assert.match(lines.at(-1)!, /not started/);
  assert.equal(existsSync(join(dir, "ran")), false, "the command never started");
});
