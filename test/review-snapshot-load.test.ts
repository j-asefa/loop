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
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db");
const { captureSnapshot, snapshotFingerprint } =
  await import("../src/server/review-snapshot");
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
    '#!/bin/sh\nprintf "git\\n" >> "$LOOP_TEST_GIT_LOG"\ncase " $* " in\n  *" --batch "*) tee -a "$LOOP_TEST_GIT_LOG.blobs" | "$LOOP_TEST_REAL_GIT" "$@" ;;\n  *) exec "$LOOP_TEST_REAL_GIT" "$@" ;;\nesac\n',
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
    expect(snapshot.context?.["file129.txt"]).toBe(
      git("rev-parse", "HEAD:file129.txt").toString().trim(),
    );
    expect(snapshot.context?.["empty.txt"]).toBe(
      git("rev-parse", "HEAD:empty.txt").toString().trim(),
    );
    expect(snapshot.context?.["same-a.txt"]).toBe(
      snapshot.context?.["same-b.txt"],
    );
    expect(snapshot.omitted).not.toContain("binary.bin");
    expect(snapshot.context?.["binary.bin"]).toBe(
      git("rev-parse", "HEAD:binary.bin").toString().trim(),
    );
    expect(snapshot.omitted).toContain("oversized.txt");
    expect(snapshot.files["oversized.txt"]).toBeUndefined();
    expect(snapshot.files["binary.bin"]).toBeUndefined();
    expect(
      readFileSync(log + ".blobs", "utf8")
        .trim()
        .split("\n"),
    ).toEqual([
      git("rev-parse", "HEAD:file000.txt").toString().trim(),
      git("rev-parse", "HEAD~1:file000.txt").toString().trim(),
    ]);
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

it("references more than 16 MB of context but still refuses oversized inline changes", () => {
  const repo = join(dir, "large");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  for (let i = 0; i < 40; i++)
    writeFileSync(join(repo, `context-${i}.txt`), "x".repeat(450_000));
  writeFileSync(join(repo, "changed.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  writeFileSync(join(repo, "changed.txt"), "after\n");
  const first = captureSnapshot(repo, "uncommitted");
  expect(Object.keys(first.files)).toEqual(["changed.txt"]);
  expect(Object.keys(first.context!)).toHaveLength(40);
  expect(JSON.stringify(first).length).toBeLessThan(10_000);
  writeFileSync(join(repo, "context-0.txt"), "new context\n");
  git("add", "context-0.txt");
  git("commit", "-m", "context only");
  const second = captureSnapshot(repo, "uncommitted");
  expect(second.files).toEqual(first.files);
  expect(second.before).toEqual(first.before);
  expect(second.diff).toEqual(first.diff);
  // Isolate reference identity from the independently fingerprinted head/base.
  expect(
    snapshotFingerprint({ ...second, head: first.head, base: first.base }),
  ).not.toBe(snapshotFingerprint(first));
  for (let i = 0; i < 40; i++)
    writeFileSync(join(repo, `context-${i}.txt`), "y".repeat(450_000));
  expect(() => captureSnapshot(repo, "uncommitted")).toThrow(
    /Changed snapshot content exceeds 16 MB/,
  );
});

it("ignores replacement objects consistently for captured context and changed text", () => {
  const repo = join(dir, "replacements");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "context.txt"), "original context\n");
  writeFileSync(join(repo, "changed.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  writeFileSync(join(repo, "changed.txt"), "after\n");
  git("add", ".");
  git("commit", "-m", "change");
  const context = git("rev-parse", "HEAD:context.txt").trim();
  const changed = git("rev-parse", "HEAD:changed.txt").trim();
  writeFileSync(join(repo, "replacement.bin"), Buffer.from([0, 1, 2]));
  const replacement = git("hash-object", "-w", "replacement.bin").trim();
  git("replace", context, replacement);
  git("replace", changed, replacement);
  const snapshot = captureSnapshot(repo, "branch", "HEAD~1");
  expect(snapshot.context?.["context.txt"]).toBe(context);
  expect(snapshot.files["changed.txt"]).toBe("after\n");
  expect(snapshot.before["changed.txt"]).toBe("before\n");
  expect(snapshot.omitted).not.toContain("context.txt");
});

it("refuses more than 20,000 context references with a 413", () => {
  const repo = join(dir, "many-contexts");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "changed.txt"), "before\n");
  const hash = git("hash-object", "-w", "changed.txt").trim();
  const entries = Array.from(
    { length: 20001 },
    (_, i) => `100644 ${hash}\tcontext-${i}.txt\n`,
  ).join("");
  execFileSync("git", ["update-index", "--index-info"], {
    cwd: repo,
    input: entries,
  });
  git("add", "changed.txt");
  git("commit", "-m", "baseline");
  writeFileSync(join(repo, "changed.txt"), "after\n");
  git("add", "changed.txt");
  git("commit", "-m", "change");
  expect(() => captureSnapshot(repo, "branch", "HEAD~1")).toThrow(
    /20,000 context references/,
  );
  try {
    captureSnapshot(repo, "branch", "HEAD~1");
  } catch (error) {
    expect(error).toMatchObject({ status: 413 });
  }
});

it.each(["count", "bytes"])(
  "bounds excluded context metadata by %s",
  (limit) => {
    const repo = join(dir, `omitted-${limit}`);
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(join(repo, "changed.txt"), "before\n");
    const hash = git("hash-object", "-w", "changed.txt").trim();
    const count = limit === "count" ? 2001 : 1500;
    const prefix = limit === "count" ? ".hidden" : "." + "x".repeat(100);
    const entries = Array.from(
      { length: count },
      (_, i) => `100644 ${hash}\t${prefix}-${i}.txt\n`,
    ).join("");
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: repo,
      input: entries,
    });
    git("add", "changed.txt");
    git("commit", "-m", "baseline");
    writeFileSync(join(repo, "changed.txt"), "after\n");
    git("add", "changed.txt");
    git("commit", "-m", "change");
    expect(() => captureSnapshot(repo, "branch", "HEAD~1")).toThrow(
      /Snapshot omission metadata exceeds/,
    );
    if (limit === "bytes") {
      // Historical format assembled independently from the new capture code.
      const historical = {
        scope: "branch" as const,
        base: git("rev-parse", "HEAD~1").trim(),
        head: git("rev-parse", "HEAD").trim(),
        diff: git(
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--unified=3",
          "HEAD~1",
          "HEAD",
          "--",
          "changed.txt",
        ),
        files: { "changed.txt": "after\n" },
        before: { "changed.txt": "before\n" },
        changed: ["changed.txt"],
        omitted: Array.from(
          { length: count },
          (_, i) => `${prefix}-${i}.txt`,
        ).sort(),
      };
      const recaptured = captureSnapshot(
        repo,
        "branch",
        "HEAD~1",
        "legacy-inline",
      );
      expect(recaptured).toEqual(historical);
      expect(snapshotFingerprint(recaptured)).toBe(
        snapshotFingerprint(historical),
      );
    }
  },
);

it.each(["assume-unchanged", "skip-worktree"])(
  "refuses hidden uncommitted context behind %s",
  (flag) => {
    const repo = join(dir, flag);
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(join(repo, "caller.txt"), "committed caller\n");
    writeFileSync(join(repo, "changed.txt"), "before\n");
    git("add", ".");
    git("commit", "-m", "baseline");
    git("update-index", `--${flag}`, "caller.txt");
    writeFileSync(join(repo, "caller.txt"), "hidden edited caller\n");
    writeFileSync(join(repo, "changed.txt"), "after\n");
    expect(() => captureSnapshot(repo, "uncommitted")).toThrow(
      /assume-unchanged or skip-worktree/,
    );
    expect(
      captureSnapshot(repo, "uncommitted", "main", "legacy-inline").files[
        "caller.txt"
      ],
    ).toBe("hidden edited caller\n");
    git("update-index", `--no-${flag}`, "caller.txt");
    const first = captureSnapshot(repo, "uncommitted");
    expect(first.files["caller.txt"]).toBe("hidden edited caller\n");
    writeFileSync(join(repo, "caller.txt"), "further edit\n");
    expect(snapshotFingerprint(captureSnapshot(repo, "uncommitted"))).not.toBe(
      snapshotFingerprint(first),
    );
  },
);

it("refuses clean-filter context before diff can invoke the filter", () => {
  const repo = join(dir, "filters");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "filter.fixture.clean", "sed s/worktree/blob/g");
  writeFileSync(join(repo, ".gitattributes"), "caller.txt filter=fixture\n");
  writeFileSync(join(repo, "caller.txt"), "worktree caller\n");
  writeFileSync(join(repo, "changed.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  writeFileSync(join(repo, "changed.txt"), "after\n");
  expect(git("diff", "--name-only").trim()).toBe("changed.txt");
  expect(git("show", "HEAD:caller.txt")).toBe("blob caller\n");
  const marker = join(repo, "filter-executed");
  git("config", "filter.fixture.clean", "touch filter-executed; cat");
  expect(() => captureSnapshot(repo, "uncommitted")).toThrow(
    /Git content conversions/,
  );
  expect(() => readFileSync(marker)).toThrow();
});

it.each([
  "text",
  "working-tree-encoding=UTF-8",
  "eol=lf",
  "ident",
  "crlf",
  "autocrlf",
])("refuses normalized uncommitted context with %s", (attribute) => {
  const repo = mkdtempSync(join(dir, "conversion-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "caller.txt"), "caller\n");
  writeFileSync(join(repo, "changed.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  writeFileSync(join(repo, "changed.txt"), "after\n");
  if (attribute === "autocrlf") git("config", "core.autocrlf", "input");
  else writeFileSync(join(repo, ".gitattributes"), `caller.txt ${attribute}\n`);
  expect(() => captureSnapshot(repo, "uncommitted")).toThrow(
    /Git content conversions/,
  );
});

it("rejects ident-normalized working edits that Git omits from its changed list", () => {
  const repo = join(dir, "ident-expansion");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, ".gitattributes"), "caller.txt ident\n");
  writeFileSync(join(repo, "caller.txt"), "$Id$\n");
  writeFileSync(join(repo, "changed.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  writeFileSync(join(repo, "caller.txt"), "$Id: hidden-working-content $\n");
  writeFileSync(join(repo, "changed.txt"), "after\n");
  expect(git("diff", "--name-only").trim()).toBe("changed.txt");
  expect(() => captureSnapshot(repo, "uncommitted")).toThrow(
    /Git content conversions/,
  );
});
