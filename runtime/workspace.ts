import {
  mkdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export function managedWorkspace(
  home: string,
  key?: string,
  recordUse = false,
): string {
  if (
    key !== undefined &&
    (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))
  )
    throw new Error("Invalid agent workspace");
  // The connection's home is already a persistent Docker volume. Separate
  // agents keep separate checkouts while every turn of one agent reuses its work.
  const cwd = join(home, "workspaces", key || "default");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (recordUse) {
    const temp = join(cwd, `.loop-last-used-${randomUUID()}`);
    try {
      if (
        realpathSync(cwd) !==
        join(realpathSync(home), "workspaces", key || "default")
      )
        return cwd;
      writeFileSync(temp, "", { mode: 0o600, flag: "wx" });
      renameSync(
        temp,
        join(cwd, ".loop-last-used"),
      );
    } catch {
      // Maintenance metadata must never prevent a user turn. An invalid marker
      // also makes cleanup preserve the workspace's dependencies.
    } finally {
      try {
        rmSync(temp, { force: true });
      } catch {}
    }
  }
  return cwd;
}

export function githubEnvironment(token: unknown) {
  if (
    typeof token !== "string" ||
    !token ||
    token.length > 8192 ||
    /[\r\n\0]/.test(token)
  )
    throw new Error("Invalid GitHub credential");
  return {
    GH_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    // Reset inherited helpers for GitHub; use an environment-only credential
    // rather than embedding it in a URL, argv, git config or a credential file.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: "!node /runtime/git-credential.mjs",
  };
}
