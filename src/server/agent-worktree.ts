import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

export class AgentWorktreeError extends Error {}

type Identity = {
  ownerId: string;
  agentId: string;
  environmentId: string;
  projectId: string;
};
export type AgentWorkspace = {
  directory: string;
  worktreeSource: string | null;
};
type GitResult = {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
};

// Repository-local variables from `git rev-parse --local-env-vars`, plus
// discovery overrides. A caller's repository must not override our -C path.
// Keep transport settings such as GIT_SSH_COMMAND and GIT_ASKPASS for fetches.
const repositoryEnvironment = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);
const transportConfiguration = new Set([
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
]);
function gitOptions(transport = false) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !repositoryEnvironment.has(key) ||
        (transport && transportConfiguration.has(key)),
    ),
  );
  return {
    encoding: "utf8" as const,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  };
}
async function gitAsync(
  directory: string,
  ...args: string[]
): Promise<GitResult> {
  const transport = args[0] === "fetch";
  // Fetch needs the caller's authentication configuration. Resolve its target
  // without inherited overrides, then pin both paths before restoring config.
  const paths = transport
    ? [
        "--git-dir=" +
          gitOutput(
            await gitAsync(directory, "rev-parse", "--absolute-git-dir"),
          ),
        "--work-tree=" +
          gitOutput(await gitAsync(directory, "rev-parse", "--show-toplevel")),
      ]
    : [];
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", directory, ...paths, ...args],
      gitOptions(transport),
      (error, stdout, stderr) => {
        resolve({
          error: error && typeof error.code !== "number" ? error : undefined,
          status: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function identityRequired(identity: Identity) {
  for (const key of [
    "ownerId",
    "agentId",
    "environmentId",
    "projectId",
  ] as const)
    if (typeof identity[key] !== "string" || !identity[key])
      throw new AgentWorktreeError(
        "Agent workspace requires a complete identity",
      );
}

function isGitProject(project: string) {
  return gitProjectStatus(
    project,
    spawnSync(
      "git",
      ["-C", project, "rev-parse", "--is-inside-work-tree"],
      gitOptions(),
    ),
  );
}
function gitProjectStatus(project: string, result: GitResult) {
  if (!result.error && result.status === 0 && result.stdout.trim() === "true")
    return true;
  // Only an explicit non-repository result permits direct directory use.
  // Permission errors, missing Git and broken repositories must not disable
  // isolation. A damaged .git directory can produce the same discovery error.
  if (
    !result.error &&
    result.status === 128 &&
    result.stderr.startsWith("fatal: not a git repository (or any")
  ) {
    for (let directory = project; ; directory = dirname(directory)) {
      try {
        lstatSync(join(directory, ".git"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (dirname(directory) === directory) return false;
    }
  }
  throw new AgentWorktreeError(
    "Could not verify the project's Git status. Check Git installation, repository access and metadata before retrying.",
  );
}

/** Pin a conversation to either an isolated checkout or an ordinary directory. */
export function agentWorkspace(
  root: string,
  project: string,
  identity: Identity,
  expected?: AgentWorkspace,
): AgentWorkspace {
  identityRequired(identity);
  root = realpathSync(root);
  project = realpathSync(project);
  inside(root, project);
  if (!statSync(project).isDirectory())
    throw new AgentWorktreeError("Agent project directory is missing");
  // An existing worktree is always verified strictly, even if its source has
  // lost its Git metadata. Never fall back to the original shared directory.
  if (expected?.worktreeSource)
    return {
      directory: agentWorktree(root, project, identity, expected.directory),
      worktreeSource: project,
    };
  if (expected && expected.directory !== project)
    throw new AgentWorktreeError(
      "Agent project directory was redirected; restore it before resuming",
    );
  if (isGitProject(project)) {
    if (expected)
      throw new AgentWorktreeError(
        "This project is now a Git repository. Start a new conversation to use an agent worktree; the existing session is preserved.",
      );
    return {
      directory: agentWorktree(root, project, identity),
      worktreeSource: project,
    };
  }
  return { directory: project, worktreeSource: null };
}

/** Prepare a fresh import without blocking the API or holding a DB transaction. */
export async function prepareAgentWorkspace(
  root: string,
  project: string,
  identity: Identity,
  allowWorktree = true,
): Promise<AgentWorkspace> {
  identityRequired(identity);
  root = realpathSync(root);
  project = realpathSync(project);
  inside(root, project);
  if (!statSync(project).isDirectory())
    throw new AgentWorktreeError("Agent project directory is missing");
  const runGit = async (...args: string[]) =>
    gitOutput(await gitAsync(project, ...args));
  if (
    !gitProjectStatus(
      project,
      await gitAsync(project, "rev-parse", "--is-inside-work-tree"),
    )
  )
    return { directory: project, worktreeSource: null };
  if (!allowWorktree)
    throw new AgentWorktreeError(
      "Importing this harness's native context into a new Git worktree is not supported. Start a new conversation; the original native history is preserved.",
    );
  const top = realpathSync(await runGit("rev-parse", "--show-toplevel"));
  const common = realpathSync(
    await runGit("rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const paths = worktreePaths(project, identity, top, common);
  mkdirSync(paths.storage, { recursive: true, mode: 0o700 });
  if (realpathSync(paths.storage) !== paths.storage)
    throw new AgentWorktreeError("Worktree storage was redirected");
  if (!existsSync(paths.checkout)) {
    const registered = (
      await runGit("worktree", "list", "--porcelain", "-z")
    ).split("\0");
    if (registered.includes("worktree " + paths.checkout))
      throw new AgentWorktreeError(
        "Registered agent worktree is missing; restore it before resuming",
      );
    const refs = (
      await runGit(
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/main",
        "refs/remotes",
      )
    ).split("\n");
    const localMain = refs.includes("refs/heads/main");
    const upstream = localMain
      ? await runGit("for-each-ref", "--format=%(upstream)", "refs/heads/main")
      : "";
    const remote = mainRemote(
      refs,
      upstream,
      localMain ? (await runGit("remote")).split("\n") : [],
    );
    if (remote) {
      try {
        await runGit(
          "fetch",
          "--no-tags",
          "--",
          remote,
          "+refs/heads/main:refs/remotes/" + remote + "/main",
        );
      } catch {
        throw new AgentWorktreeError(
          "Could not fetch latest main for a new agent worktree; check remote access and retry.",
        );
      }
    }
    const base = await runGit(
      "rev-parse",
      "--verify",
      (remote
        ? "refs/remotes/" + remote + "/main"
        : localMain
          ? "refs/heads/main"
          : "HEAD") + "^{commit}",
    );
    await runGit(
      "worktree",
      "add",
      "-b",
      "loop55/agent-" + paths.key,
      paths.checkout,
      base,
    );
  }
  return verifyAgentWorkspace(root, project, identity, {
    directory: paths.directory,
    worktreeSource: project,
  });
}

/** Read-only validation for API polling; Git must not block the event loop. */
export async function verifyAgentWorkspace(
  root: string,
  project: string,
  identity: Identity,
  expected: AgentWorkspace,
): Promise<AgentWorkspace> {
  identityRequired(identity);
  root = realpathSync(root);
  project = realpathSync(project);
  inside(root, project);
  if (!statSync(project).isDirectory())
    throw new AgentWorktreeError("Agent project directory is missing");
  if (!expected.worktreeSource) {
    if (expected.directory !== project)
      throw new AgentWorktreeError(
        "Agent project directory was redirected; restore it before resuming",
      );
    if (
      gitProjectStatus(
        project,
        await gitAsync(project, "rev-parse", "--is-inside-work-tree"),
      )
    )
      throw new AgentWorktreeError(
        "This project is now a Git repository. Start a new conversation to use an agent worktree; the existing session is preserved.",
      );
    return { directory: project, worktreeSource: null };
  }
  const top = realpathSync(
    gitOutput(await gitAsync(project, "rev-parse", "--show-toplevel")),
  );
  const common = realpathSync(
    gitOutput(
      await gitAsync(
        project,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    ),
  );
  const paths = worktreePaths(project, identity, top, common);
  if (expected.directory !== paths.directory)
    throw new AgentWorktreeError("Launch worktree identity cannot change");
  if (!existsSync(paths.checkout))
    throw new AgentWorktreeError(
      "Existing agent worktree is missing; restore it before resuming",
    );
  verifyWorktreePaths(paths);
  const checkoutTop = realpathSync(
    gitOutput(await gitAsync(paths.checkout, "rev-parse", "--show-toplevel")),
  );
  const checkoutCommon = realpathSync(
    gitOutput(
      await gitAsync(
        paths.checkout,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    ),
  );
  if (checkoutTop !== paths.checkout || checkoutCommon !== common)
    throw new AgentWorktreeError(
      "Agent worktree identity could not be verified",
    );
  return { directory: paths.directory, worktreeSource: project };
}

function git(directory: string, ...args: string[]): string {
  const transport = args[0] === "fetch";
  const paths = transport
    ? [
        "--git-dir=" + git(directory, "rev-parse", "--absolute-git-dir"),
        "--work-tree=" + git(directory, "rev-parse", "--show-toplevel"),
      ]
    : [];
  return gitOutput(
    spawnSync(
      "git",
      ["-C", directory, ...paths, ...args],
      gitOptions(transport),
    ),
  );
}
function gitOutput(result: GitResult) {
  if (result.error || result.status !== 0)
    throw new AgentWorktreeError(
      "Agent worktree could not be verified; select a Git repository with a commit and check its worktrees.",
    );
  return result.stdout.trim();
}
function inside(root: string, path: string) {
  const sub = relative(root, path);
  if (sub === ".." || sub.startsWith("../") || isAbsolute(sub))
    throw new AgentWorktreeError(
      "Agent worktree escaped the approved project root",
    );
}

function worktreePaths(
  project: string,
  identity: Identity,
  top: string,
  common: string,
) {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        identity.ownerId,
        identity.agentId,
        identity.environmentId,
        identity.projectId,
        project,
      ]),
    )
    .digest("hex");
  // Existing checkouts contain harness-owned context and possibly uncommitted work.
  // Retain their registered path and branch; new agents use the Loop55 namespace.
  const legacy = join(common, "loop-agent-worktrees", key);
  const storage = existsSync(legacy)
    ? join(common, "loop-agent-worktrees")
    : join(common, "loop55-agent-worktrees");
  const checkout = join(storage, key);
  return {
    key,
    storage,
    checkout,
    directory: join(checkout, relative(top, project)),
  };
}
function verifyWorktreePaths({
  storage,
  checkout,
  directory,
}: ReturnType<typeof worktreePaths>) {
  if (realpathSync(storage) !== storage)
    throw new AgentWorktreeError("Worktree storage was redirected");
  if (realpathSync(checkout) !== checkout)
    throw new AgentWorktreeError(
      "Agent worktree identity could not be verified",
    );
  inside(checkout, realpathSync(directory));
  if (!statSync(directory).isDirectory())
    throw new AgentWorktreeError("Worktree project directory is missing");
}

function mainRemote(refs: string[], upstream: string, remotes: string[]) {
  const remoteMain =
    upstream.startsWith("refs/remotes/") && upstream.endsWith("/main")
      ? upstream
      : refs.includes("refs/remotes/origin/main")
        ? "refs/remotes/origin/main"
        : "";
  return remoteMain
    ? remoteMain.slice("refs/remotes/".length, -"/main".length)
    : remotes.includes("origin")
      ? "origin"
      : "";
}
function newWorktreeBase(project: string) {
  const refs = git(
    project,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/main",
    "refs/remotes",
  ).split("\n");
  const localMain = refs.includes("refs/heads/main");
  const upstream = localMain
    ? git(project, "for-each-ref", "--format=%(upstream)", "refs/heads/main")
    : "";
  const remote = mainRemote(
    refs,
    upstream,
    localMain ? git(project, "remote").split("\n") : [],
  );
  if (remote) {
    try {
      git(
        project,
        "fetch",
        "--no-tags",
        "--",
        remote,
        "+refs/heads/main:refs/remotes/" + remote + "/main",
      );
    } catch {
      throw new AgentWorktreeError(
        "Could not fetch latest main for a new agent worktree; check remote access and retry.",
      );
    }
    // Resolve immediately to an immutable commit rather than a shared ref that
    // another worker's fetch could move during worktree creation.
    return git(
      project,
      "rev-parse",
      "--verify",
      "refs/remotes/" + remote + "/main^{commit}",
    );
  }
  return git(
    project,
    "rev-parse",
    "--verify",
    (localMain ? "refs/heads/main" : "HEAD") + "^{commit}",
  );
}

// Synchronous Git operations serialize preparations in this worker. Git's own
// locks arbitrate across workers; a conflicting/partial creation fails closed.
export function agentWorktree(
  root: string,
  project: string,
  identity: Identity,
  expectedDirectory?: string,
) {
  identityRequired(identity);
  root = realpathSync(root);
  project = realpathSync(project);
  inside(root, project);
  const top = realpathSync(git(project, "rev-parse", "--show-toplevel"));
  const common = realpathSync(
    git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const paths = worktreePaths(project, identity, top, common);
  const { key, storage, checkout, directory } = paths;
  // Keep managed checkouts in Git's private directory, outside tracked content.
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  if (realpathSync(storage) !== storage)
    throw new AgentWorktreeError("Worktree storage was redirected");
  if (expectedDirectory && expectedDirectory !== directory)
    throw new AgentWorktreeError("Launch worktree identity cannot change");
  if (!existsSync(checkout)) {
    const registered = git(
      project,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ).split("\0");
    if (registered.includes("worktree " + checkout))
      throw new AgentWorktreeError(
        "Registered agent worktree is missing; restore it before resuming",
      );
    if (expectedDirectory)
      throw new AgentWorktreeError(
        "Existing agent worktree is missing; restore it before resuming",
      );
    git(
      project,
      "worktree",
      "add",
      "-b",
      "loop55/agent-" + key,
      checkout,
      newWorktreeBase(project),
    );
  }
  verifyWorktreePaths(paths);
  if (
    realpathSync(git(checkout, "rev-parse", "--show-toplevel")) !== checkout ||
    realpathSync(
      git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    ) !== common
  )
    throw new AgentWorktreeError(
      "Agent worktree identity could not be verified",
    );
  return directory;
}
