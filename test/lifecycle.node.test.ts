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
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { identity, workspaceLock } from "../src/lifecycle.js";
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

test("a recoverer killed mid-recovery does not block later starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-recovery-"));
  const stale = (nonce: string) =>
    JSON.stringify({ pid: 99999999, identity: "dead", nonce });
  try {
    writeFileSync(join(dir, "host.lock"), stale("old-host"));
    writeFileSync(join(dir, "host.lock.recovery"), stale("old-recoverer"));
    const release = workspaceLock(dir);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")).pid,
      process.pid,
    );
    assert(!existsSync(join(dir, "host.lock.recovery")));
    release();
    // A live recoverer keeps its record and the lock it is recovering.
    const live = JSON.stringify({
      pid: process.pid,
      identity: identity(process.pid),
      nonce: "live-recoverer",
    });
    writeFileSync(join(dir, "host.lock"), stale("old-host"));
    writeFileSync(join(dir, "host.lock.recovery"), live);
    assert.throws(() => workspaceLock(dir), /recovering the workspace lock/);
    assert.equal(readFileSync(join(dir, "host.lock.recovery"), "utf8"), live);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock whose PID now belongs to another user's process is recovered", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-eperm-"));
  try {
    // PID 1 is alive and, for a non-root test, signalling it fails with
    // EPERM; its identity is not the crashed host's.
    writeFileSync(
      join(dir, "host.lock"),
      JSON.stringify({ pid: 1, identity: "crashed-host", nonce: "old" }),
    );
    const release = workspaceLock(dir);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")).pid,
      process.pid,
    );
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled macOS workspace lock preserves a live owner across a timezone change", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-mac-timezone-"));
  try {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        import { readFileSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { workspaceLock } from ${JSON.stringify(pathToFileURL(resolve("dist/lifecycle.js")).href)};
        process.env.TZ = "UTC";
        const dir = ${JSON.stringify(dir)}, release = workspaceLock(dir), path = join(dir, "host.lock");
        try {
          const retained = readFileSync(path, "utf8");
          process.env.TZ = "Pacific/Honolulu";
          assert.throws(() => workspaceLock(dir), /starting or running/);
          assert.equal(readFileSync(path, "utf8"), retained);
        } finally { release(); }
      `,
      ],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(resolve("test/fixtures/execution-macos-hooks.mjs")).href}`,
        },
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
