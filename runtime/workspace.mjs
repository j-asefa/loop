import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function managedWorkspace(home, key) {
  if (
    key !== undefined &&
    (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))
  )
    throw new Error("Invalid agent workspace");
  // The connection's home is already a persistent Docker volume. Separate
  // agents keep separate checkouts while every turn of one agent reuses its work.
  const cwd = join(home, "workspaces", key || "default");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

export function githubEnvironment(token) {
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
