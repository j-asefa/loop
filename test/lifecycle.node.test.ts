process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceLock } from "../src/lifecycle.js";
test("workspace ownership is exclusive, recovers a proven stale owner, and never removes a replacement lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"));
  try {
    const release = workspaceLock(dir);
    assert.throws(() => workspaceLock(dir), /starting or running/);
    release();
    assert(!existsSync(join(dir, "host.lock")));
    writeFileSync(
      join(dir, "host.lock"),
      JSON.stringify({ pid: 99999999, identity: "dead", nonce: "old" }),
    );
    const next = workspaceLock(dir);
    const record = JSON.parse(readFileSync(join(dir, "host.lock"), "utf8"));
    assert.equal(record.pid, process.pid);
    writeFileSync(
      join(dir, "host.lock"),
      JSON.stringify({ ...record, nonce: "replacement" }),
    );
    next();
    assert(existsSync(join(dir, "host.lock")));
    writeFileSync(join(dir, "host.lock"), "invalid");
    assert.throws(() => workspaceLock(dir), /unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
