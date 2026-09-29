import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupWorktree } from "./cleanup-worktree.mjs";

const registryName = ".loop-cleanup";
const inside = (root, path) => {
  const rel = relative(root, path);
  return (
    !!rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)
  );
};
async function registry(workspace, create = false) {
  const root = await realpath(workspace);
  const path = join(root, registryName);
  if (create) await mkdir(path, { mode: 0o700, recursive: true });
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error(
      "Cleanup registry must be a directory in the agent's workspace.",
    );
  return { root, path };
}

export async function trackPullRequest(workspace, checkout, pr) {
  if (
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*\/?$/.test(pr)
  )
    throw new Error("Supply a GitHub pull request URL.");
  const { root, path } = await registry(workspace, true);
  const repo = await realpath(checkout);
  if (!inside(root, repo) || repo === path || inside(path, repo))
    throw new Error("Track only a checkout inside your own workspace.");
  const name = createHash("sha256").update(repo).digest("hex") + ".json";
  const temp = join(path, randomUUID() + ".tmp");
  await writeFile(
    temp,
    JSON.stringify({ checkout: relative(root, repo), pr }),
    { mode: 0o600, flag: "wx" },
  );
  await rename(temp, join(path, name));
  return { tracked: true, checkout: relative(root, repo), pr };
}

async function registeredJobs(workspace) {
  let location;
  try {
    location = await registry(workspace);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const { root, path } = location;
  const files = (await readdir(path)).filter((name) =>
    /^[a-f0-9]{64}\.json$/.test(name),
  );
  // Oldest checks first so one blocked job cannot starve newer jobs. A bounded
  // batch keeps idle maintenance from holding a connection for too long.
  const records = [];
  for (const name of files) {
    const file = join(path, name),
      stat = await lstat(file);
    if (!stat.isFile() || stat.size > 4096) continue;
    try {
      const record = JSON.parse(await readFile(file, "utf8"));
      if (
        typeof record.checkout !== "string" ||
        typeof record.pr !== "string" ||
        !inside(root, resolve(root, record.checkout))
      )
        continue;
      records.push({ root, path, file, record });
    } catch {
      /* Invalid agent-authored records are never deletion authority. */
    }
  }
  return records;
}

export const cleanupRegistered = (workspace, env = process.env) =>
  cleanupWorkspaces([workspace], env);

export async function cleanupWorkspaces(workspaces, env = process.env) {
  const records = [];
  for (const workspace of workspaces) {
    try {
      records.push(...(await registeredJobs(workspace)));
    } catch {
      /* An invalid registry cannot authorize deleting a checkout. */
    }
  }
  records.sort(
    (a, b) =>
      (Number(a.record.checkedAt) || 0) - (Number(b.record.checkedAt) || 0),
  );
  const results = [];
  for (const { root, path, file, record } of records.slice(0, 8)) {
    try {
      const result = await cleanupWorktree(
        root,
        resolve(root, record.checkout),
        record.pr,
        env,
      );
      results.push({ pr: record.pr, ...result });
      if (result.retired) {
        await rm(file);
        continue;
      }
    } catch (error) {
      results.push({
        pr: record.pr,
        retired: false,
        reason: error.cmd
          ? "Could not verify the pull request or checkout."
          : error.message,
      });
    }
    // Replace atomically; never follow a registry file swapped for a symlink.
    const temp = join(path, randomUUID() + ".tmp");
    await writeFile(
      temp,
      JSON.stringify({
        ...record,
        checkedAt: Date.now(),
        lastResult: results.at(-1),
      }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(temp, file);
  }
  return results;
}

export function workspaceCleanupInstructions(workspace) {
  return `\nRepository workspace lifecycle: reuse one clone per repository; use a separate linked Git worktree and branch for each job. Do not accumulate full clones. When you create or take ownership of a PR, register its checkout for automatic post-merge cleanup with: node /runtime/workspace-cleanup.mjs track ${JSON.stringify(workspace)} <checkout-path> <https://github.com/owner/repo/pull/number>. Keep the worktree while the PR is open. Loop checks registered jobs when the connection is idle and retires them after merge, including ignored node_modules and build directories. Only the exact merged PR head with no uncommitted or untracked work is eligible; never bypass this with force, git reset --hard, or blanket git clean. Upload user deliverables to Loop before retiring a job. You may remove your own unused dependencies and reproducible build outputs during work, but preserve source, local changes, uploads, credentials and other agents' files. Run node /runtime/workspace-cleanup.mjs sweep ${JSON.stringify(workspace)} to request cleanup yourself. GitHub's automatic head-branch deletion handles remote branches separately.`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, workspace, checkout, pr] = process.argv.slice(2);
    if (command === "track" && process.argv.length === 6)
      console.log(
        JSON.stringify(await trackPullRequest(workspace, checkout, pr)),
      );
    else if (command === "sweep" && process.argv.length === 4)
      console.log(JSON.stringify(await cleanupRegistered(workspace)));
    else
      throw new Error(
        "Usage: workspace-cleanup.mjs track <workspace> <checkout> <pr-url> | sweep <workspace>",
      );
  } catch (error) {
    console.error(
      error.cmd ? "Workspace cleanup could not be completed." : error.message,
    );
    process.exitCode = 1;
  }
}
