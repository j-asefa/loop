import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  alive,
  identity,
  processState,
  recordedProcessDead,
  groupMembers,
  recordedGroupAlive,
} from "../src/process-records.js";
import { workspaceLock } from "../src/lifecycle.js";

test(
  "a live process whose name contains a closing parenthesis and Z retains its identity and lock",
  { skip: process.platform !== "linux", timeout: 10000 },
  async () => {
    const child = spawn(
      "python3",
      [
        "-u",
        "-c",
        `
import ctypes, os, sys
print(os.getpid(), flush=True)
sys.stdin.readline()
assert ctypes.CDLL(None).prctl(15, b"loop) Z name", 0, 0, 0) == 0
print("renamed", flush=True)
sys.stdin.readline()
`,
      ],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines = createInterface({ input: child.stdout });
    const exited = once(child, "exit");
    const dir = mkdtempSync(join(tmpdir(), "loop-process-name-"));
    try {
      const [pidLine] = await once(lines, "line");
      const pid = Number(pidLine);
      assert.equal(pid, child.pid);
      const start = identity(pid);
      assert.ok(start);
      const renamed = once(lines, "line");
      child.stdin.write("rename\n");
      assert.deepEqual(await renamed, ["renamed"]);
      const record = { pid, identity: start };
      assert.equal(identity(pid), start);
      assert.equal(alive(pid), true);
      assert.equal(processState(record), "running");
      assert.equal(recordedProcessDead(record), false);
      assert.ok(groupMembers(pid).includes(pid));
      assert.equal(recordedGroupAlive(record), true);
      writeFileSync(
        join(dir, "host.lock"),
        JSON.stringify({ ...record, nonce: randomUUID() }),
      );
      assert.throws(() => workspaceLock(dir), /starting or running/);
    } finally {
      child.kill("SIGKILL");
      await exited;
      lines.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
