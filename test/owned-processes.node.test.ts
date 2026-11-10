import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alive,
  killOwned,
  ownedGroupAlive,
  recordOwnedChild,
  recordOwnedProcesses,
  recordedChildren,
} from "../src/process-records.js";

async function fixture(t: TestContext, detached: boolean) {
  const dir = fs.mkdtempSync(join(tmpdir(), "loop-owned-process-"));
  recordOwnedProcesses(join(dir, "children.json"));
  const child = spawn(
    process.execPath,
    ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'],
    {
      detached,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const ended = once(child, "exit");
  t.after(async () => {
    child.kill("SIGKILL");
    await ended;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(child.stdout, "data");
  return { child, ended, dir };
}

test("an attached child is stopped individually and its record is retired", async (t) => {
  const { child, ended, dir } = await fixture(t, false);
  recordOwnedChild(child, "process");
  assert.equal(ownedGroupAlive(child), false);
  assert.equal((await recordedChildren(dir)).length, 1);
  assert.equal(killOwned(child, "SIGTERM"), true);
  await ended;
  assert.equal(killOwned(child, "SIGKILL"), false);
  assert.deepEqual(await recordedChildren(dir), []);
});

test(
  "a detached group must be registered before it can be signalled",
  { skip: process.platform === "win32" },
  async (t) => {
    const { child, ended } = await fixture(t, true);
    assert.equal(killOwned(child, "SIGTERM"), false);
    assert.equal(alive(child.pid!), true);
    recordOwnedChild(child, "group");
    assert.equal(ownedGroupAlive(child), true);
    assert.equal(killOwned(child, "SIGTERM"), true);
    await ended;
    assert.equal(ownedGroupAlive(child), false);
  },
);

test(
  "an unreadable launch identity is retained and cannot authorize a later group signal",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { child, dir } = await fixture(t, true);
    const read = fs.readFileSync;
    const failure = t.mock.method(
      fs,
      "readFileSync",
      (path: fs.PathOrFileDescriptor, options: any) => {
        if (path === `/proc/${child.pid}/stat`)
          throw Object.assign(new Error("Fixture unreadable stat"), {
            code: "EACCES",
          });
        return read(path, options);
      },
    );
    syncBuiltinESMExports();
    try {
      recordOwnedChild(child, "group");
    } finally {
      failure.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await recordedChildren(dir), [
      { pid: child.pid, identity: "" },
    ]);
    assert.equal(killOwned(child, "SIGKILL"), false);
    assert.equal(alive(child.pid!), true);
    assert.equal(ownedGroupAlive(child), true);
    assert.deepEqual(await recordedChildren(dir), [
      { pid: child.pid, identity: "" },
    ]);
  },
);
