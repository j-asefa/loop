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

async function fixture(t: TestContext, detached: boolean, descendant = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), "loop-owned-process-"));
  recordOwnedProcesses(join(dir, "children.json"));
  const child = spawn(
    process.execPath,
    [
      "-e",
      descendant
        ? `
      const {spawn}=require("node:child_process");
      const member=spawn(process.execPath,["-e",'console.log("ready");setInterval(()=>{},1000)'],{stdio:["ignore","pipe","ignore"]});
      member.stdout.once("data",()=>console.log(member.pid));
      setInterval(()=>{},1000);
    `
        : 'console.log("ready"); setInterval(() => {}, 1000)',
    ],
    {
      detached,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const ended = once(child, "exit");
  let member: number | undefined;
  t.after(async () => {
    child.kill("SIGKILL");
    await ended;
    if (member) {
      try {
        process.kill(member, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + 2000;
      while (alive(member) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(alive(member), false, "fixture descendant stopped");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [ready] = await once(child.stdout, "data");
  if (descendant) member = Number(String(ready).trim());
  return { child, ended, dir, member };
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
  "an unreadable launch identity permits direct child termination but never a surviving group signal",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { child, ended, dir, member } = await fixture(t, true, true);
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
    assert.equal(killOwned(child, "SIGKILL"), true);
    await ended;
    assert.equal(alive(child.pid!), false);
    assert.equal(alive(member!), true);
    assert.equal(killOwned(child, "SIGKILL"), false);
    assert.equal(ownedGroupAlive(child), true);
    assert.deepEqual(await recordedChildren(dir), [
      { pid: child.pid, identity: "" },
    ]);
  },
);
