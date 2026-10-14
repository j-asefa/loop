import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export class AgentWorktreeError extends Error {}

function git(directory: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0)
    throw new AgentWorktreeError("Agent worktree could not be verified; select a Git repository with a commit and check its worktrees.");
  return result.stdout.trim();
}
function inside(root: string, path: string) {
  const sub = relative(root, path);
  if (sub === ".." || sub.startsWith("../") || isAbsolute(sub))
    throw new AgentWorktreeError("Agent worktree escaped the approved project root");
}

function newWorktreeBase(project: string) {
  const refs = git(project, "for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/remotes").split("\n");
  const localMain = refs.includes("refs/heads/main");
  const upstream = localMain ? git(project, "for-each-ref", "--format=%(upstream)", "refs/heads/main") : "";
  const remoteMain = upstream.startsWith("refs/remotes/") && upstream.endsWith("/main") ? upstream :
    refs.includes("refs/remotes/origin/main") ? "refs/remotes/origin/main" : "";
  const remote = remoteMain ? remoteMain.slice("refs/remotes/".length, -"/main".length) :
    localMain && git(project, "remote").split("\n").includes("origin") ? "origin" : "";
  if (remote) {
    try {
      git(project, "fetch", "--no-tags", "--", remote, "+refs/heads/main:refs/remotes/" + remote + "/main");
    } catch {
      throw new AgentWorktreeError("Could not fetch latest main for a new agent worktree; check remote access and retry.");
    }
    // Resolve immediately to an immutable commit rather than a shared ref that
    // another worker's fetch could move during worktree creation.
    return git(project, "rev-parse", "--verify", "refs/remotes/" + remote + "/main^{commit}");
  }
  return git(project, "rev-parse", "--verify", (localMain ? "refs/heads/main" : "HEAD") + "^{commit}");
}

// Synchronous Git operations serialize preparations in this worker. Git's own
// locks arbitrate across workers; a conflicting/partial creation fails closed.
export function agentWorktree(root: string, project: string, identity: { ownerId: string; agentId: string; environmentId: string; projectId: string }, expectedDirectory?: string) {
  for (const key of ["ownerId", "agentId", "environmentId", "projectId"] as const)
    if (typeof identity[key] !== "string" || !identity[key])
      throw new AgentWorktreeError("Agent worktree requires a complete identity");
  root = realpathSync(root);
  project = realpathSync(project);
  inside(root, project);
  const top = realpathSync(git(project, "rev-parse", "--show-toplevel"));
  const common = realpathSync(git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const key = createHash("sha256").update(JSON.stringify([
    identity.ownerId, identity.agentId, identity.environmentId, identity.projectId, project,
  ])).digest("hex");
  // Keep managed checkouts in Git's private directory, outside tracked content.
  const storage = join(common, "loop-agent-worktrees");
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  if (realpathSync(storage) !== storage) throw new AgentWorktreeError("Worktree storage was redirected");
  const checkout = join(storage, key);
  const directory = join(checkout, relative(top, project));
  if (expectedDirectory && expectedDirectory !== directory)
    throw new AgentWorktreeError("Launch worktree identity cannot change");
  if (!existsSync(checkout)) {
    const registered = git(project, "worktree", "list", "--porcelain", "-z").split("\0");
    if (registered.includes("worktree " + checkout))
      throw new AgentWorktreeError("Registered agent worktree is missing; restore it before resuming");
    if (expectedDirectory) throw new AgentWorktreeError("Existing agent worktree is missing; restore it before resuming");
    git(project, "worktree", "add", "-b", "loop/agent-" + key, checkout, newWorktreeBase(project));
  }
  if (realpathSync(checkout) !== checkout ||
      realpathSync(git(checkout, "rev-parse", "--show-toplevel")) !== checkout ||
      realpathSync(git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")) !== common)
    throw new AgentWorktreeError("Agent worktree identity could not be verified");
  // A subdirectory mapping must exist in committed HEAD; never fall back to the
  // shared project when it is missing or redirected.
  inside(checkout, realpathSync(directory));
  if (!statSync(directory).isDirectory()) throw new AgentWorktreeError("Worktree project directory is missing");
  return directory;
}
