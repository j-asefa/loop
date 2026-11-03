import { afterEach, beforeEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  realpath,
  symlink,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
const { cleanupWorktree } = await import(
  resolve("runtime/cleanup-worktree.ts")
);
const { trackPullRequest, cleanupRegistered } = await import(
  resolve("runtime/workspace-cleanup.ts")
);
let root: string, repo: string, job: string, env: NodeJS.ProcessEnv, pr: any;
const url = "https://github.com/acme/project/pull/42";
const git = async (path: string, ...args: string[]) =>
  (await exec("git", ["-C", path, ...args], { env })).stdout.trim();
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const savePr = () => writeFile(join(root, "pr.json"), JSON.stringify(pr));
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "loop-worktree-cleanup-")),
  );
  repo = join(root, "repo");
  job = join(root, "job");
  await mkdir(repo);
  await mkdir(join(root, "bin"));
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: join(root, "bin") + ":" + process.env.PATH,
    CLEANUP_PR_FIXTURE: join(root, "pr.json"),
  };
  await writeFile(
    join(root, "bin", "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== 'api repos/acme/project/pulls/42') process.exit(2);
console.log(fs.readFileSync(process.env.CLEANUP_PR_FIXTURE, 'utf8'));
`,
    { mode: 0o755 },
  );
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Cleanup Fixture");
  await git(repo, "config", "user.email", "fixture@example.test");
  await git(
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/project.git",
  );
  await writeFile(
    join(repo, ".gitignore"),
    "node_modules/\ndist/\nbuild/\ncoverage/\n.env\n",
  );
  await writeFile(join(repo, "source.ts"), "export const value = 1;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "worktree", "add", "-b", "job-42", job);
  await writeFile(join(job, "source.ts"), "export const value = 2;\n");
  await git(job, "commit", "-am", "job");
  const head = await git(job, "rev-parse", "HEAD");
  pr = {
    merged: true,
    merged_at: "2026-09-29T12:00:00Z",
    merge_commit_sha: "c".repeat(40),
    base: { ref: "main", repo: { full_name: "acme/project" } },
    head: {
      ref: "job-42",
      sha: head,
      repo: { full_name: "acme/project", default_branch: "main" },
    },
  };
  await savePr();
  for (const path of [
    "node_modules/pkg",
    "dist",
    "build",
    "packages/web/node_modules/pkg",
    "packages/web/coverage",
  ]) {
    await mkdir(join(job, path), { recursive: true });
    await writeFile(join(job, path, "generated.txt"), "reproducible output");
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("removes dependencies, nested builds, linked worktree and local branch after a squash merge", async () => {
  expect(await git(repo, "branch", "--merged", "main")).not.toContain("job-42");
  for (const path of [
    "node_modules/pkg/generated.txt",
    "dist/generated.txt",
    "build/generated.txt",
    "packages/web/node_modules/pkg/generated.txt",
    "packages/web/coverage/generated.txt",
  ]) {
    await rm(join(job, path));
  }
  await rm(join(job, "node_modules/pkg"), { recursive: true });
  await rm(join(job, "packages/web/node_modules/pkg"), { recursive: true });
  const result = await cleanupWorktree(root, job, url, env);
  expect(result).toMatchObject({
    retired: true,
    worktreeRemoved: true,
    branch: "job-42",
  });
  expect(result.removed).toEqual(
    expect.arrayContaining([
      "node_modules",
      "dist",
      "build",
      "packages/web/node_modules",
      "packages/web/coverage",
    ]),
  );
  expect(await exists(job)).toBe(false);
  expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(job);
  expect(await git(repo, "branch", "--list", "job-42")).toBe("");
  expect(await readFile(join(repo, "source.ts"), "utf8")).toContain(
    "value = 1",
  );
});

it.each([
  "open",
  "closed-unmerged",
  "different-head",
  "different-origin",
  "default-branch",
])("preserves everything for %s", async (kind) => {
  if (kind === "open" || kind === "closed-unmerged") {
    pr.merged = false;
    pr.state = kind === "open" ? "open" : "closed";
  }
  if (kind === "different-head") pr.head.sha = "d".repeat(40);
  if (kind === "different-origin") pr.head.repo.full_name = "someone/else";
  if (kind === "default-branch") pr.head.repo.default_branch = "job-42";
  await savePr();
  await expect(cleanupWorktree(root, job, url, env)).rejects.toThrow();
  expect(await exists(join(job, "node_modules/pkg/generated.txt"))).toBe(true);
  expect(await git(repo, "branch", "--list", "job-42")).toContain("job-42");
});

it.each(["tracked", "untracked", "locked"])(
  "preserves %s work before removing any generated files",
  async (kind) => {
    if (kind === "tracked")
      await writeFile(join(job, "source.ts"), "uncommitted work");
    if (kind === "untracked")
      await writeFile(join(job, "new-source.ts"), "untracked work");
    if (kind === "locked") await git(repo, "worktree", "lock", job);
    await expect(cleanupWorktree(root, job, url, env)).rejects.toThrow();
    expect(await exists(join(job, "node_modules"))).toBe(true);
  },
);

it("preserves ignored credentials and populated generated directories", async () => {
  await writeFile(join(job, ".env"), "keep this local credential");
  const result = await cleanupWorktree(root, job, url, env);
  expect(result.retired).toBe(false);
  expect(result.removed).toEqual([]);
  expect(await exists(join(job, "node_modules/pkg/generated.txt"))).toBe(true);
  expect(await readFile(join(job, ".env"), "utf8")).toBe(
    "keep this local credential",
  );
  expect(await git(job, "branch", "--show-current")).toBe("job-42");
});

it.each(["dist/.env", "node_modules/pkg/local-notes.txt"])(
  "preserves a checkout with a user file inside %s",
  async (path) => {
    await writeFile(join(job, path), "keep this local file");
    const result = await cleanupWorktree(root, job, url, env);
    expect(result).toMatchObject({ retired: false, removed: [] });
    expect(await readFile(join(job, path), "utf8")).toBe(
      "keep this local file",
    );
    expect(await git(job, "branch", "--show-current")).toBe("job-42");
  },
);

it("cleans a standalone clone while retaining it for reuse", async () => {
  await git(repo, "worktree", "remove", "--force", job); // Fixture-only setup.
  await git(repo, "switch", "job-42");
  for (const path of ["node_modules", "dist", "build"]) {
    await rm(join(repo, path), { recursive: true, force: true });
  }
  await mkdir(join(repo, "node_modules"));
  const result = await cleanupWorktree(root, repo, url, env);
  expect(result).toMatchObject({ retired: true, worktreeRemoved: false });
  expect(await exists(repo)).toBe(true);
  expect(await exists(join(repo, "node_modules"))).toBe(false);
  expect(await readFile(join(repo, "source.ts"), "utf8")).toContain(
    "value = 2",
  );
  expect(await git(repo, "branch", "--show-current")).toBe("");
});

it("never follows a dependency symlink to files outside the checkout", async () => {
  const outside = join(root, "valuable");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  await rm(join(job, "node_modules"), { recursive: true });
  await symlink(outside, join(job, "node_modules"));
  await expect(cleanupWorktree(root, job, url, env)).rejects.toThrow(
    "untracked",
  );
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
});

it("persists registration while a PR is open and cleans it on a later merge check", async () => {
  await trackPullRequest(root, job, url);
  pr.merged = false;
  await savePr();
  expect((await cleanupRegistered(root, env))[0].retired).toBe(false);
  expect((await readdir(join(root, ".loop-cleanup"))).length).toBe(1);
  pr.merged = true;
  await savePr();
  for (const path of [
    "node_modules",
    "dist",
    "build",
    "packages/web/node_modules",
    "packages/web/coverage",
  ]) {
    await rm(join(job, path), { recursive: true });
  }
  expect((await cleanupRegistered(root, env))[0].retired).toBe(true);
  expect(await readdir(join(root, ".loop-cleanup"))).toEqual([]);
  expect(await cleanupRegistered(root, env)).toEqual([]);
});

it("refuses out-of-workspace paths and symlinked cleanup registries", async () => {
  await expect(cleanupWorktree(repo, job, url, env)).rejects.toThrow("inside");
  await expect(trackPullRequest(repo, job, url)).rejects.toThrow("inside");
  await rm(join(repo, ".loop-cleanup"), { recursive: true });
  await symlink(job, join(repo, ".loop-cleanup"));
  await expect(trackPullRequest(repo, job, url)).rejects.toThrow("registry");
  expect(await exists(join(job, "node_modules"))).toBe(true);
});

it("preflights an eligible registered checkout without deleting it or updating its registry", async () => {
  const { cleanupWorkspaces } = await import(
    resolve("runtime/workspace-cleanup.ts")
  );
  for (const path of [
    "node_modules",
    "dist",
    "build",
    "packages/web/node_modules",
    "packages/web/coverage",
  ])
    await rm(join(job, path), { recursive: true });
  await mkdir(join(job, "dist"));
  await trackPullRequest(root, job, url);
  const registry = join(root, ".loop-cleanup");
  const [file] = await readdir(registry);
  const before = await readFile(join(registry, file), "utf8");
  expect((await cleanupWorkspaces([root], env, true))[0]).toMatchObject({
    eligible: true,
    retired: false,
  });
  expect(await exists(job)).toBe(true);
  expect(await readFile(join(registry, file), "utf8")).toBe(before);
});
