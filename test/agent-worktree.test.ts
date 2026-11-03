import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  agentWorkspace,
  agentWorktree,
  prepareAgentWorkspace,
  verifyAgentWorkspace,
} from "../src/server/agent-worktree.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
  return agentWorktree(dir, dir, {
    ownerId: "owner",
    agentId,
    environmentId: "fixture",
    projectId: dir,
  });
}

it.each(["missing", "foreign"])(
  "keeps ordinary folders direct with %s inherited Git metadata",
  async (mode) => {
    const foreign = fixture();
    const project = mkdtempSync(join(tmpdir(), "loop-plain-workspace-"));
    directories.push(project);
    const identity = {
      ownerId: "owner",
      agentId: mode,
      environmentId: "fixture",
      projectId: project,
    };
    const expected = { directory: project, worktreeSource: null };
    vi.stubEnv(
      "GIT_DIR",
      join(foreign, mode === "missing" ? "missing" : ".git"),
    );
    vi.stubEnv("GIT_WORK_TREE", foreign);
    vi.stubEnv("GIT_COMMON_DIR", join(foreign, ".git"));
    expect(agentWorkspace(project, project, identity)).toEqual(expected);
    await expect(
      prepareAgentWorkspace(project, project, identity),
    ).resolves.toEqual(expected);
    await expect(
      verifyAgentWorkspace(project, project, identity, expected),
    ).resolves.toEqual(expected);
    expect(existsSync(join(foreign, ".git", "loop-agent-worktrees"))).toBe(
      false,
    );
  },
);

it("creates and validates the selected repository's worktree despite inherited Git overrides", async () => {
  const project = fixture();
  const foreign = fixture();
  commit(foreign, "foreign content");
  const identity = {
    ownerId: "owner",
    agentId: "inherited",
    environmentId: "fixture",
    projectId: project,
  };
  for (const [name, value] of Object.entries({
    GIT_DIR: join(foreign, ".git"),
    GIT_WORK_TREE: foreign,
    GIT_COMMON_DIR: join(foreign, ".git"),
    GIT_INDEX_FILE: join(foreign, ".git", "index"),
    GIT_OBJECT_DIRECTORY: join(foreign, ".git", "objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: foreign,
  }))
    vi.stubEnv(name, value);
  const workspace = agentWorkspace(project, project, identity);
  expect(workspace.worktreeSource).toBe(project);
  expect(
    workspace.directory.startsWith(
      join(project, ".git", "loop-agent-worktrees") + "/",
    ),
  ).toBe(true);
  expect(readFileSync(join(workspace.directory, "tracked.txt"), "utf8")).toBe(
    "initial",
  );
  expect(agentWorkspace(project, project, identity, workspace)).toEqual(
    workspace,
  );
  await expect(
    verifyAgentWorkspace(project, project, identity, workspace),
  ).resolves.toEqual(workspace);
  expect(existsSync(join(foreign, ".git", "loop-agent-worktrees"))).toBe(false);
});

it.each(["count", "parameters", "file"])(
  "preserves %s Git transport configuration while fetching into the selected repository",
  async (mode) => {
    const remote = fixture(),
      repo = fixture(),
      foreign = fixture();
    commit(remote, "authenticated remote content");
    commit(foreign, "unrelated repository");
    const sourceHead = git(repo, "rev-parse", "HEAD"),
      foreignHead = git(foreign, "rev-parse", "HEAD");
    const transport = join(repo, "fixture-transport.cjs");
    writeFileSync(
      transport,
      `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const header = execFileSync("git", ["config", "--get", "http.extraHeader"], { encoding: "utf8" }).trim();
if (header !== "Authorization: fixture-only") process.exit(1);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
execFileSync("git-upload-pack", [process.argv[2]], { stdio: "inherit", env });
`,
      { mode: 0o700 },
    );
    git(repo, "config", "protocol.ext.allow", "always");
    git(repo, "remote", "add", "origin", "ext::" + transport + " " + remote);
    if (mode === "count") {
      vi.stubEnv("GIT_CONFIG_COUNT", "2");
      vi.stubEnv("GIT_CONFIG_KEY_0", "http.extraHeader");
      vi.stubEnv("GIT_CONFIG_VALUE_0", "Authorization: fixture-only");
      vi.stubEnv("GIT_CONFIG_KEY_1", "core.worktree");
      vi.stubEnv("GIT_CONFIG_VALUE_1", foreign);
    } else if (mode === "parameters") {
      vi.stubEnv(
        "GIT_CONFIG_PARAMETERS",
        "'http.extraHeader=Authorization: fixture-only' 'core.worktree=" +
          foreign +
          "'",
      );
    } else {
      const file = join(repo, "fixture-gitconfig");
      writeFileSync(
        file,
        "[http]\n extraHeader = Authorization: fixture-only\n[core]\n worktree = " +
          foreign +
          "\n",
      );
      vi.stubEnv("GIT_CONFIG", file);
    }
    vi.stubEnv("GIT_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_COMMON_DIR", join(foreign, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign);
    const first = worktree(repo, "transport-sync");
    const second = await prepareAgentWorkspace(repo, repo, {
      ownerId: "owner",
      agentId: "transport-async",
      environmentId: "fixture",
      projectId: repo,
    });
    for (const directory of [first, second.directory]) {
      expect(
        directory.startsWith(join(repo, ".git", "loop-agent-worktrees") + "/"),
      ).toBe(true);
      expect(readFileSync(join(directory, "tracked.txt"), "utf8")).toBe(
        "authenticated remote content",
      );
    }
    vi.unstubAllEnvs();
    expect(git(repo, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(git(foreign, "rev-parse", "HEAD")).toBe(foreignHead);
    expect(existsSync(join(foreign, ".git", "loop-agent-worktrees"))).toBe(
      false,
    );
  },
);

it("fetches latest main for new agents without changing the source or existing agents", async () => {
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
  expect(git(second, "rev-parse", "HEAD")).toBe(
    git(remote, "rev-parse", "main"),
  );
  expect(readFileSync(join(second, "tracked.txt"), "utf8")).toBe("latest");
  expect(git(repo, "rev-parse", "HEAD")).toBe(sourceHead);
  expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("source edit");
  git(repo, "remote", "set-url", "origin", join(remote, "missing"));
  expect(worktree(repo, "first")).toBe(first);
  expect(readFileSync(join(first, "tracked.txt"), "utf8")).toBe("agent edit");
  expect(() => worktree(repo, "third")).toThrow(/Could not fetch latest main/);
  await expect(
    prepareAgentWorkspace(repo, repo, {
      ownerId: "owner",
      agentId: "import",
      environmentId: "fixture",
      projectId: repo,
    }),
  ).rejects.toThrow(/Could not fetch latest main/);
});

it("uses local main ahead of a feature checkout when no remote exists", () => {
  const repo = fixture();
  git(repo, "checkout", "-b", "feature");
  commit(repo, "feature");
  expect(git(worktree(repo, "local"), "rev-parse", "HEAD")).toBe(
    git(repo, "rev-parse", "main"),
  );
});

it("preserves HEAD behavior for repositories without main", () => {
  const repo = fixture("trunk");
  expect(git(worktree(repo, "trunk"), "rev-parse", "HEAD")).toBe(
    git(repo, "rev-parse", "HEAD"),
  );
});

it("fetches main from its configured upstream rather than origin", async () => {
  const upstream = fixture();
  const repo = fixture();
  git(repo, "remote", "add", "upstream", upstream);
  git(repo, "fetch", "upstream");
  git(repo, "branch", "--set-upstream-to=upstream/main", "main");
  commit(upstream, "upstream latest");
  expect(git(worktree(repo, "upstream"), "rev-parse", "HEAD")).toBe(
    git(upstream, "rev-parse", "HEAD"),
  );
  commit(upstream, "latest import");
  const imported = await prepareAgentWorkspace(repo, repo, {
    ownerId: "owner",
    agentId: "import-upstream",
    environmentId: "fixture",
    projectId: repo,
  });
  expect(git(imported.directory, "rev-parse", "HEAD")).toBe(
    git(upstream, "rev-parse", "HEAD"),
  );
});

it("retains a Loop55-era registered worktree, branch and uncommitted native workspace", () => {
  const repo = fixture();
  const current = worktree(repo, "legacy");
  const key = current.split("/").at(-1)!;
  const storage = join(repo, ".git", "loop55-agent-worktrees");
  mkdirSync(storage);
  const legacy = join(storage, key);
  git(current, "branch", "-m", "loop55/agent-" + key);
  git(repo, "worktree", "move", current, legacy);
  writeFileSync(join(legacy, "uncommitted.txt"), "original native workspace");
  expect(worktree(repo, "legacy")).toBe(legacy);
  expect(readFileSync(join(legacy, "uncommitted.txt"), "utf8")).toBe(
    "original native workspace",
  );
  expect(git(legacy, "branch", "--show-current")).toBe("loop55/agent-" + key);
});
