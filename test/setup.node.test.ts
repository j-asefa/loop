import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setupSource = new URL("../scripts/setup.mjs", import.meta.url);
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

test("setup preserves existing environment and configures blame for older linked worktrees", () => {
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
    const revisions = `# Formatting only\n${formatting}\n`;
    writeFileSync(join(repository, ".git-blame-ignore-revs"), revisions);
    git(repository, "worktree", "add", "--detach", oldWorktree, initial);
    installSetup(repository);
    const environment =
      "LOOP_RUNTIME_TOKEN=fixture-token\nCUSTOM_SETTING=preserved\n";
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
    assert.equal(readFileSync(configured, "utf8"), revisions);
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
    assert.match(runSetup(repository), /\.env already exists; preserved/);
    assert.equal(readFileSync(join(repository, ".env"), "utf8"), environment);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup in a source archive creates local config without configuring its parent repository", () => {
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
    assert.match(runSetup(archive), /Created local configuration/);
    const environment = readFileSync(join(archive, ".env"), "utf8");
    assert.match(environment, /^LOOP_RUNTIME_TOKEN=[a-f0-9]{64}$/m);
    assert.equal(statSync(join(archive, ".env")).mode & 0o777, 0o600);
    assert.equal(
      git(root, "config", "blame.ignoreRevsFile"),
      "existing-parent-setting",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
