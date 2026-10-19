import { afterAll, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-snapshot-load-"));
process.env.LOOP_DATA_DIR = join(dir, "data");
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db");
const { captureSnapshot } = await import("../src/server/review-snapshot");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("captures repository context with bounded Git processes and preserves byte-framed blobs", () => {
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  for (let i = 0; i < 130; i++)
    writeFileSync(
      join(repo, `file${String(i).padStart(3, "0")}.txt`),
      `Context ${i}: café 漢字 🙂\n`,
    );
  writeFileSync(join(repo, "empty.txt"), "");
  writeFileSync(join(repo, "same-a.txt"), "duplicate blob\n");
  writeFileSync(join(repo, "same-b.txt"), "duplicate blob\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([1, 0, 2]));
  writeFileSync(join(repo, "oversized.txt"), "x".repeat(512001));
  git("add", ".");
  git("commit", "-m", "baseline");
  writeFileSync(join(repo, "file000.txt"), "New α🙂 content\n");
  git("add", "file000.txt");
  git("commit", "-m", "change");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const log = join(dir, "git-calls.log");
  writeFileSync(
    join(bin, "git"),
    '#!/bin/sh\nprintf "git\\n" >> "$LOOP_TEST_GIT_LOG"\nexec "$LOOP_TEST_REAL_GIT" "$@"\n',
    { mode: 0o755 },
  );
  const previous = {
    PATH: process.env.PATH,
    LOOP_TEST_GIT_LOG: process.env.LOOP_TEST_GIT_LOG,
    LOOP_TEST_REAL_GIT: process.env.LOOP_TEST_REAL_GIT,
  };
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    LOOP_TEST_GIT_LOG: log,
    LOOP_TEST_REAL_GIT: realGit,
  });
  try {
    const snapshot = captureSnapshot(repo, "branch", "HEAD~1");
    expect(snapshot.changed).toEqual(["file000.txt"]);
    expect(snapshot.files["file000.txt"]).toBe("New α🙂 content\n");
    expect(snapshot.before["file000.txt"]).toBe("Context 0: café 漢字 🙂\n");
    expect(snapshot.files["file129.txt"]).toBe("Context 129: café 漢字 🙂\n");
    expect(snapshot.files["empty.txt"]).toBe("");
    expect(snapshot.files["same-a.txt"]).toBe(snapshot.files["same-b.txt"]);
    expect(snapshot.omitted).toContain("binary.bin");
    expect(snapshot.omitted).toContain("oversized.txt");
    expect(snapshot.files["oversized.txt"]).toBeUndefined();
    expect(snapshot.files["binary.bin"]).toBeUndefined();
    const calls = readFileSync(log, "utf8").trim().split("\n").length;
    console.log(
      `Snapshot capture used ${calls} Git processes for 135 context files.`,
    );
    expect(calls).toBeLessThanOrEqual(20);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
