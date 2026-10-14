import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { agentWorktree } from "../src/server/agent-worktree.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(branch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "loop-worktree-base-"));
  directories.push(dir);
  git(dir, "init", "-b", branch);
  git(dir, "config", "user.email", "fixture@example.com");
  git(dir, "config", "user.name", "Fixture");
  commit(dir, "initial");
  return dir;
}
function commit(dir: string, value: string) {
  writeFileSync(join(dir, "tracked.txt"), value);
  git(dir, "add", "tracked.txt");
  git(dir, "commit", "-m", value);
}
function worktree(dir: string, agentId: string) {
  return agentWorktree(dir, dir, { ownerId: "owner", agentId, environmentId: "fixture", projectId: dir });
}

it("fetches latest main for new agents without changing the source or existing agents", () => {
  const remote = fixture();
  const repo = fixture();
  git(repo, "remote", "add", "origin", remote);
  git(repo, "fetch", "origin");
  git(repo, "checkout", "-b", "feature");
  commit(repo, "feature");
  const sourceHead = git(repo, "rev-parse", "HEAD");
  const first = worktree(repo, "first");
  expect(readFileSync(join(first, "tracked.txt"), "utf8")).toBe("initial");
  writeFileSync(join(first, "tracked.txt"), "agent edit");
  commit(remote, "latest");
  writeFileSync(join(repo, "tracked.txt"), "source edit");
  const second = worktree(repo, "second");
  expect(git(second, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
  expect(readFileSync(join(second, "tracked.txt"), "utf8")).toBe("latest");
  expect(git(repo, "rev-parse", "HEAD")).toBe(sourceHead);
  expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("source edit");
  git(repo, "remote", "set-url", "origin", join(remote, "missing"));
  expect(worktree(repo, "first")).toBe(first);
  expect(readFileSync(join(first, "tracked.txt"), "utf8")).toBe("agent edit");
  expect(() => worktree(repo, "third")).toThrow(/Could not fetch latest main/);
});

it("uses local main ahead of a feature checkout when no remote exists", () => {
  const repo = fixture();
  git(repo, "checkout", "-b", "feature");
  commit(repo, "feature");
  expect(git(worktree(repo, "local"), "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
});

it("preserves HEAD behavior for repositories without main", () => {
  const repo = fixture("trunk");
  expect(git(worktree(repo, "trunk"), "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
});

it("fetches main from its configured upstream rather than origin", () => {
  const upstream = fixture();
  const repo = fixture();
  git(repo, "remote", "add", "upstream", upstream);
  git(repo, "fetch", "upstream");
  git(repo, "branch", "--set-upstream-to=upstream/main", "main");
  commit(upstream, "upstream latest");
  expect(git(worktree(repo, "upstream"), "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});
