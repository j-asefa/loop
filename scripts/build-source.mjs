import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function buildSource(root) {
  const stamp = {
    id: randomUUID(),
    repository: null,
    commit: null,
    clean: false,
    builtAt: Date.now(),
    ancestors: [],
  };
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  let directory;
  try {
    const commit = git("rev-parse", "HEAD");
    const remote = git("config", "--get", "remote.origin.url");
    if (
      !/^[0-9a-f]{40}$/.test(commit) ||
      !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)j-asefa\/loop(?:\.git)?\/?$/i.test(
        remote,
      ) ||
      git("status", "--porcelain")
    )
      return { directory: root, stamp, cleanup: async () => {} };
    // Build the named immutable tree, never mutable checkout files after a
    // clean check. New edits during the build cannot change its provenance.
    directory = await mkdtemp(join(tmpdir(), "loop55-build-"));
    const archive = execFileSync(
      "git",
      ["-C", root, "archive", "--format=tar", commit],
      { maxBuffer: 128 * 1024 * 1024 },
    );
    execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
    await symlink(
      resolve(root, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    Object.assign(stamp, {
      repository: "github.com/j-asefa/loop",
      commit,
      clean: true,
      ancestors: git("rev-list", "--max-count=10000", commit)
        .split("\n")
        .filter((x) => /^[0-9a-f]{40}$/.test(x)),
    });
    return {
      directory,
      stamp,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true });
    return { directory: root, stamp, cleanup: async () => {} };
  }
}
