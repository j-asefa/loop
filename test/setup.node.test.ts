import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setupSource = new URL("../scripts/setup.mjs", import.meta.url);
const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
function installSetup(root: string) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(setupSource, join(root, "scripts/setup.mjs"));
}
function runSetup(root: string) {
  return execFileSync(process.execPath, ["scripts/setup.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("setup keeps blame usable in a shallow clone and adds revisions after fetching history", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-setup-shallow-"));
  const repository = join(root, "repository");
  const shallow = join(root, "shallow");
  try {
    mkdirSync(repository);
    git(repository, "init", "-q");
    git(repository, "config", "user.email", "fixture@example.invalid");
    git(repository, "config", "user.name", "Setup fixture");
    writeFileSync(join(repository, "example.ts"), "const value=1;\n");
    git(repository, "add", "example.ts");
    git(repository, "commit", "-qm", "Initial source");
    const initial = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "example.ts"), "const value = 1;\n");
    git(repository, "commit", "-qam", "Format source");
    const formatting = git(repository, "rev-parse", "HEAD");
    installSetup(repository);
    writeFileSync(
      join(repository, ".git-blame-ignore-revs"),
      `${formatting}\n`,
    );
    git(repository, "add", "scripts/setup.mjs", ".git-blame-ignore-revs");
    git(repository, "commit", "-qm", "Configure setup");
    git(
      root,
      "clone",
      "--quiet",
      "--depth=1",
      pathToFileURL(repository).href,
      shallow,
    );
    assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", formatting], {
        cwd: shallow,
        stdio: "ignore",
      }).status,
      0,
    );
    assert.match(runSetup(shallow), /Git blame ignores/);
    const configured = git(
      shallow,
      "config",
      "--local",
      "blame.ignoreRevsFile",
    );
    assert.equal(readFileSync(configured, "utf8").trim(), "");
    assert.match(
      git(shallow, "blame", "--porcelain", "example.ts"),
      /const value = 1/,
    );

    git(shallow, "fetch", "--unshallow", "origin");
    runSetup(shallow);
    assert.equal(readFileSync(configured, "utf8").trim(), formatting);
    assert.match(
      git(shallow, "blame", "--porcelain", "example.ts"),
      new RegExp(initial),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup preserves the environment and shared revision history across linked worktrees", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-setup-git-"));
  const repository = join(root, "repository");
  const oldWorktree = join(root, "old");
  try {
    mkdirSync(repository);
    git(repository, "init", "-q");
    git(repository, "config", "user.email", "fixture@example.invalid");
    git(repository, "config", "user.name", "Setup fixture");
    writeFileSync(join(repository, "example.ts"), "const value=1;\n");
    git(repository, "add", "example.ts");
    git(repository, "commit", "-qm", "Initial source");
    const initial = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "example.ts"), "const value = 1;\n");
    git(repository, "commit", "-qam", "Format source");
    const formatting = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "example.ts"), "const value =\n  1;\n");
    git(repository, "commit", "-qam", "Reformat source");
    const newerFormatting = git(repository, "rev-parse", "HEAD");
    const revisions = `# Formatting only\n${formatting}\n${newerFormatting}\n`;
    writeFileSync(join(repository, ".git-blame-ignore-revs"), revisions);
    git(repository, "worktree", "add", "--detach", oldWorktree, initial);
    installSetup(repository);
    const environment =
      "LOOP_ENCRYPTION_KEY=fixture-key\nCUSTOM_SETTING=preserved\n";
    writeFileSync(join(repository, ".env"), environment);

    assert.match(runSetup(repository), /Git blame ignores/);
    assert.equal(readFileSync(join(repository, ".env"), "utf8"), environment);
    const configured = git(
      repository,
      "config",
      "--local",
      "blame.ignoreRevsFile",
    );
    assert.equal(
      configured,
      join(repository, ".git", "loop-blame-ignore-revs"),
    );
    const sharedRevisions = () =>
      new Set(readFileSync(configured, "utf8").trim().split(/\s+/));
    assert.deepEqual(sharedRevisions(), new Set([formatting, newerFormatting]));
    assert.equal(
      git(oldWorktree, "config", "--local", "blame.ignoreRevsFile"),
      configured,
    );
    assert.equal(
      existsSync(join(oldWorktree, ".git-blame-ignore-revs")),
      false,
    );
    assert.match(
      git(oldWorktree, "blame", "--porcelain", "example.ts"),
      new RegExp(initial),
    );
    assert.match(
      git(repository, "blame", "--porcelain", "example.ts"),
      new RegExp(initial),
    );
    assert.match(runSetup(repository), /Git blame ignores/);
    assert.equal(readFileSync(join(repository, ".env"), "utf8"), environment);

    // Setup from a stale worktree must not erase the newer formatting commit.
    installSetup(oldWorktree);
    writeFileSync(
      join(oldWorktree, ".git-blame-ignore-revs"),
      `${formatting}\n`,
    );
    runSetup(oldWorktree);
    assert.deepEqual(sharedRevisions(), new Set([formatting, newerFormatting]));

    // Two setups that read the same empty shared list must preserve both writes.
    writeFileSync(configured, "");
    writeFileSync(
      join(repository, ".git-blame-ignore-revs"),
      `${formatting}\n`,
    );
    writeFileSync(
      join(oldWorktree, ".git-blame-ignore-revs"),
      `${newerFormatting}\n`,
    );
    await Promise.all(
      [repository, oldWorktree].map((cwd) =>
        exec(process.execPath, ["scripts/setup.mjs"], { cwd }),
      ),
    );
    assert.deepEqual(sharedRevisions(), new Set([formatting, newerFormatting]));
    assert.equal(readFileSync(join(repository, ".env"), "utf8"), environment);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup in a source archive neither writes configuration nor configures its parent repository", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-setup-archive-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "blame.ignoreRevsFile", "existing-parent-setting");
    const archive = join(root, "archive");
    installSetup(archive);
    writeFileSync(
      join(archive, ".git-blame-ignore-revs"),
      "# No Git checkout\n",
    );
    runSetup(archive);
    assert.equal(existsSync(join(archive, ".env")), false);
    assert.equal(
      git(root, "config", "blame.ignoreRevsFile"),
      "existing-parent-setting",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
