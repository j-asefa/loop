import { execFile } from "node:child_process";
import { readdir, realpath, rmdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const generated = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vite",
  "target",
  "__pycache__",
]);
const inside = (root, path) => {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(".." + sep) &&
    !isAbsolute(rel)
  );
};
const githubRepo = (remote) => {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      remote,
    );
  return match?.[1]?.toLowerCase();
};

// This is a conservative convenience command for an agent's own checkout, not
// a sandbox or a garbage collector for arbitrary directories. Never git-clean
// all ignored files: those can include .env files, uploads and local source.
export async function cleanupWorktree(
  workspacePath,
  repoPath,
  prUrl,
  env = process.env,
) {
  const run = async (command, args) =>
    (
      await exec(command, args, {
        env,
        timeout: command === "gh" ? 5000 : 30000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  const match =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(
      prUrl,
    );
  if (!match) throw new Error("Supply a GitHub pull request URL.");
  const workspace = await realpath(workspacePath);
  const repo = await realpath(repoPath);
  if (!inside(workspace, repo))
    throw new Error(
      "The checkout must be inside this agent's workspace, not the workspace itself.",
    );
  const git = (...args) => run("git", ["-C", repo, ...args]);
  const top = await realpath(
    (await git("rev-parse", "--show-toplevel")).trim(),
  );
  if (top !== repo) throw new Error("Supply the checkout's root directory.");
  const common = await realpath(
    resolve(repo, (await git("rev-parse", "--git-common-dir")).trim()),
  );
  if (!inside(workspace, common))
    throw new Error(
      "The shared Git repository must also belong to this workspace.",
    );
  const gitDir = await realpath(
    resolve(repo, (await git("rev-parse", "--git-dir")).trim()),
  );
  const branch = (
    await git("symbolic-ref", "--quiet", "--short", "HEAD")
  ).trim();
  const head = (await git("rev-parse", "HEAD")).trim();
  const origin = githubRepo((await git("remote", "get-url", "origin")).trim());
  if (!origin) throw new Error("The checkout must have a GitHub origin.");
  // GitHub's merged flag and exact head SHA also handle squash/rebase merges,
  // where local `branch --merged` would not establish that the PR was merged.
  const pr = JSON.parse(
    await run("gh", ["api", `repos/${match[1]}/pulls/${match[2]}`]),
  );
  if (
    pr.merged !== true ||
    !pr.merged_at ||
    !/^[a-f0-9]{40,64}$/.test(pr.merge_commit_sha || "")
  )
    throw new Error(
      "The pull request is not merged. Keep the checkout for review and revisions.",
    );
  if (
    pr.base?.repo?.full_name?.toLowerCase() !== match[1].toLowerCase() ||
    pr.head?.repo?.full_name?.toLowerCase() !== origin ||
    pr.head?.ref !== branch ||
    pr.head?.sha !== head
  )
    throw new Error(
      "The merged pull request does not match this checkout's repository, branch and HEAD. Preserve the checkout.",
    );
  if (
    ["main", "master", pr.base?.ref, pr.head?.repo?.default_branch].includes(
      branch,
    )
  )
    throw new Error("Do not retire a default or base branch.");
  if (
    (
      await git(
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      )
    ).trim()
  )
    throw new Error(
      "The checkout has uncommitted or untracked work. Preserve it before cleanup.",
    );
  if (
    (await git("ls-files", "--stage", "-z"))
      .split("\0")
      .some((line) => line.startsWith("160000 "))
  )
    throw new Error("Submodule checkouts need manual review before cleanup.");
  // git worktree remove respects locks, but check before deleting any outputs.
  const worktrees = (await git("worktree", "list", "--porcelain", "-z")).split(
    "\0\0",
  );
  if (
    worktrees.some(
      (entry) =>
        entry.split("\0")[0] === `worktree ${repo}` &&
        entry.split("\0").some((line) => /^locked(?: |$)/.test(line)),
    )
  )
    throw new Error(
      "The worktree is locked. Preserve it until its owner unlocks it.",
    );
  if (
    worktrees.some((entry) => {
      const fields = entry.split("\0");
      const path = fields[0].slice("worktree ".length);
      return (
        path !== repo &&
        (inside(repo, path) || fields.includes(`branch refs/heads/${branch}`))
      );
    })
  )
    throw new Error(
      "Another worktree is nested here or uses this branch. Preserve both jobs.",
    );

  const candidates = [];
  let visited = 0;
  async function scan(path) {
    if (++visited > 50000)
      throw new Error(
        "Checkout is too large to inspect safely in one cleanup. Review it manually.",
      );
    const entries = await readdir(path, { withFileTypes: true });
    if (path !== repo && entries.some((entry) => entry.name === ".git")) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue; // Never follow symlinks.
      const child = resolve(path, entry.name);
      const rel = relative(repo, child);
      if (generated.has(entry.name)) {
        let ignored = false;
        try {
          await git("check-ignore", "--quiet", "--", rel + "/");
          ignored = true;
        } catch (error) {
          if (error.code !== 1) throw error;
        }
        if (ignored && !(await git("ls-files", "--cached", "--", rel)).trim())
          candidates.push(child);
        // Do not descend into dependency/build trees even if tracked. Their
        // nested repositories belong to packages, not to this job.
      } else await scan(child);
    }
  }
  await scan(repo);
  // Recheck after inspection; cleanup is intended to run when the job is idle.
  if (
    (await git("rev-parse", "HEAD")).trim() !== head ||
    (await git("symbolic-ref", "--quiet", "--short", "HEAD")).trim() !==
      branch ||
    (
      await git(
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      )
    ).trim()
  )
    throw new Error(
      "The checkout changed during inspection. Nothing was removed.",
    );
  const removed = [];
  // An ignored directory name does not prove that its contents are generated.
  // A build tree can also contain local credentials, uploads or source files.
  // Inspect every candidate before removing anything, and only delete empty
  // directories with rmdir so a concurrent writer cannot lose a new file.
  for (const path of candidates) {
    if ((await realpath(path)) !== path)
      throw new Error(
        "A generated directory moved during inspection. Cleanup stopped.",
      );
    if ((await readdir(path)).length)
      return {
        removed,
        retired: false,
        reason:
          "An ignored generated directory contains files or directories. The checkout and branch were kept for review.",
      };
  }
  for (const path of candidates) {
    // Refuse replaced paths or symlinked ancestors rather than following them.
    if ((await realpath(path)) !== path)
      throw new Error(
        "A generated directory moved during inspection. Cleanup stopped.",
      );
    try {
      await rmdir(path);
    } catch (error) {
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST")
        return {
          removed,
          retired: false,
          reason:
            "An ignored generated directory changed during cleanup. The checkout and branch were kept for review.",
        };
      throw error;
    }
    removed.push(relative(repo, path));
  }

  const ignored = (
    await git(
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    )
  )
    .split("\0")
    .filter(Boolean);
  if (ignored.length)
    return {
      removed,
      retired: false,
      reason:
        "Other ignored files remain (possibly credentials or user files). The checkout and branch were kept.",
    };
  if (gitDir !== common) {
    // No --force: Git performs a final dirty/lock check and updates its own
    // worktree metadata. Do not rm -rf a linked worktree.
    await run("git", ["--git-dir=" + common, "worktree", "remove", "--", repo]);
  } else {
    // Keep one small reusable clone. Detach before retiring the merged branch;
    // future jobs should use linked worktrees from this clone.
    await git("switch", "--detach", head);
  }
  // The exact ref must still point at the verified PR head. Unlike branch -D,
  // update-ref's compare-and-delete cannot discard a concurrently moved ref.
  await run("git", [
    "--git-dir=" + common,
    "update-ref",
    "-d",
    "refs/heads/" + branch,
    head,
  ]);
  return { removed, retired: true, worktreeRemoved: gitDir !== common, branch };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 5)
      throw new Error(
        "Usage: node /runtime/cleanup-worktree.mjs <agent-workspace> <checkout> <merged-pr-url>",
      );
    console.log(
      JSON.stringify(await cleanupWorktree(...process.argv.slice(2))),
    );
  } catch (error) {
    // Child-process errors can include credentials from remote URLs or stderr.
    console.error(
      error.cmd
        ? "Cleanup could not verify the repository or pull request. No unchecked deletion was attempted."
        : error.message,
    );
    process.exitCode = 1;
  }
}
