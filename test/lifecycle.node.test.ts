import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { identity, workspaceLock } from "../src/lifecycle.js";

// Records as the lock writes them; nonces are always randomUUID().
const deadRecord = (nonce = randomUUID()) =>
  JSON.stringify({ pid: 99999999, identity: "dead", nonce });
const liveRecord = (nonce = randomUUID()) =>
  JSON.stringify({ pid: process.pid, identity: identity(process.pid), nonce });
const nonceOf = (path: string) => JSON.parse(readFileSync(path, "utf8")).nonce;
function withDir(name: string, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("workspace ownership is exclusive, recovers a proven stale owner, and never removes a replacement lock", () => {
  withDir("loop-lock-", (dir) => {
    const lock = join(dir, "host.lock");
    const release = workspaceLock(dir);
    assert.throws(() => workspaceLock(dir), /starting or running/);
    release();
    assert(!existsSync(lock));
    writeFileSync(lock, deadRecord());
    const next = workspaceLock(dir);
    const record = JSON.parse(readFileSync(lock, "utf8"));
    assert.equal(record.pid, process.pid);
    writeFileSync(lock, JSON.stringify({ ...record, nonce: randomUUID() }));
    next();
    assert(existsSync(lock));
    writeFileSync(lock, "invalid");
    assert.throws(() => workspaceLock(dir), /unreadable/);
    // A nonce is used in a claim path, so a malformed one is never trusted.
    writeFileSync(
      lock,
      JSON.stringify({ pid: 99999999, identity: "dead", nonce: "../x" }),
    );
    assert.throws(() => workspaceLock(dir), /unreadable/);
  });
});

test("a stale lock whose PID now belongs to another user's process is recovered", () => {
  withDir("loop-lock-eperm-", (dir) => {
    // PID 1 is alive and, for a non-root test, signalling it fails with
    // EPERM; its identity is not the crashed host's.
    writeFileSync(
      join(dir, "host.lock"),
      JSON.stringify({ pid: 1, identity: "crashed-host", nonce: randomUUID() }),
    );
    const release = workspaceLock(dir);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")).pid,
      process.pid,
    );
    release();
  });
});

test("a live claimant on the stale lock refuses a later starter and keeps every file", () => {
  withDir("loop-lock-live-claim-", (dir) => {
    const stale = randomUUID();
    const claim = join(dir, "host.lock.stale." + stale);
    writeFileSync(join(dir, "host.lock"), deadRecord(stale));
    const claimant = liveRecord();
    writeFileSync(claim, claimant);
    assert.throws(() => workspaceLock(dir), /recovering the workspace lock/);
    assert.equal(nonceOf(join(dir, "host.lock")), stale);
    assert.equal(readFileSync(claim, "utf8"), claimant);
  });
});

test("a dead claimant's claim is taken over through its own claim, never removed after a check", () => {
  withDir("loop-lock-dead-claim-", (dir) => {
    const stale = randomUUID(),
      deadClaimant = randomUUID();
    const claim = join(dir, "host.lock.stale." + stale);
    writeFileSync(join(dir, "host.lock"), deadRecord(stale));
    writeFileSync(claim, deadRecord(deadClaimant));
    // Another starter is already taking over the dead claim: the reclaim is
    // exclusive too, so this starter refuses instead of unlinking it.
    const nested = join(dir, "host.lock.stale." + deadClaimant);
    writeFileSync(nested, liveRecord());
    assert.throws(() => workspaceLock(dir), /recovering the workspace lock/);
    assert.equal(nonceOf(join(dir, "host.lock")), stale);
    assert.equal(nonceOf(claim), deadClaimant);
    // Once that starter has gone (killed too), the chain is taken over.
    writeFileSync(nested, deadRecord());
    const release = workspaceLock(dir);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")).pid,
      process.pid,
    );
    release();
  });
});

test("deep dead claimant chains recover while a live deepest claimant stays exclusive", () => {
  withDir("loop-lock-deep-", (dir) => {
    const root = join(dir, "host.lock");
    let path = root;
    const records = new Map<string, string>();
    for (let depth = 0; depth < 12; depth++) {
      const nonce = randomUUID();
      const record = deadRecord(nonce);
      records.set(path, record);
      writeFileSync(path, record);
      path = root + ".stale." + nonce;
    }
    const live = liveRecord();
    writeFileSync(path, live);
    assert.throws(() => workspaceLock(dir), /recovering the workspace lock/);
    for (const [file, record] of records)
      assert.equal(readFileSync(file, "utf8"), record);
    assert.equal(readFileSync(path, "utf8"), live);
    writeFileSync(path, deadRecord());
    const release = workspaceLock(dir);
    assert.deepEqual(readdirSync(dir), ["host.lock"]);
    assert.throws(() => workspaceLock(dir), /starting or running/);
    release();
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("a takeover leaves no markers and removes dead starters' leftovers", () => {
  withDir("loop-lock-leftovers-", (dir) => {
    const deadTemp = randomUUID(),
      deadRename = randomUUID();
    writeFileSync(join(dir, "host.lock"), deadRecord());
    writeFileSync(join(dir, "host.lock." + deadTemp), deadRecord(deadTemp));
    writeFileSync(
      join(dir, "host.lock." + deadRename + ".new"),
      deadRecord(deadRename),
    );
    writeFileSync(join(dir, "host.lock.stale." + randomUUID()), deadRecord());
    // A live starter's temp file is not ours to remove.
    const liveTemp = randomUUID();
    writeFileSync(join(dir, "host.lock." + liveTemp), liveRecord(liveTemp));
    const release = workspaceLock(dir);
    assert.deepEqual(readdirSync(dir).sort(), [
      "host.lock",
      "host.lock." + liveTemp,
    ]);
    release();
  });
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
