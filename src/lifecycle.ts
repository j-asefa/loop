import { linkSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { atomic } from "./state.js";

const DARWIN_IDENTITY = "darwin-utc:";
function psIdentity(pid: number, normalized = false) {
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 3000,
        env: normalized
          ? { ...process.env, LC_ALL: "C", TZ: "UTC" }
          : process.env,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** Boot and start time of a live process; undefined when it can't be read. */
export function identity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return (
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() +
        ":" +
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
      );
    }
    const value = psIdentity(pid, process.platform === "darwin");
    return (
      value && (process.platform === "darwin" ? DARWIN_IDENTITY + value : value)
    );
  } catch {
    return undefined;
  }
}
export function processIdentityState(
  pid: number,
  expected: string,
): "same" | "different" | "unknown" {
  const live = identity(pid);
  if (!live || !expected) return "unknown";
  return live === expected ? "same" : "different";
}
/**
 * The PID namespace of this process. Records written in another namespace (a
 * sibling container) name PIDs that mean nothing here and are never signalled.
 */
export function pidNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
}
type Owner = { pid: number; identity: string; nonce: string };
function dead(owner: Owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
  // A zombie has exited even if PID 1 has not reaped it yet.
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z")
        return true;
    } catch {
      /* Identity verification below remains conservative. */
    }
  }
  return processIdentityState(owner.pid, owner.identity) === "different";
}
const WORKSPACE_LOCK = {
  name: "host.lock",
  owner:
    "Another Loop host is starting or running. Wait for it, then run loop again; no process was stopped.",
};
/** Complete records are installed atomically. A separate recovery lock serializes stale takeover. */
export function workspaceLock(
  dir: string,
  lock: { name: string; owner: string } = WORKSPACE_LOCK,
): () => void {
  const path = join(dir, lock.name);
  const owner: Owner = {
    pid: process.pid,
    identity: identity(process.pid) || "",
    nonce: randomUUID(),
  };
  if (!owner.identity)
    throw new Error(
      "Could not establish process identity for the workspace lock.",
    );
  const temp = path + "." + owner.nonce;
  atomic(temp, owner);
  try {
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let prior: Owner;
      try {
        prior = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        throw new Error(
          "Workspace ownership record is unreadable. Preserve the state directory and inspect the lock; do not uninstall to recover.",
        );
      }
      if (!prior.identity || !prior.nonce || !dead(prior))
        throw new Error(lock.owner);
      const recovery = path + ".recovery";
      try {
        linkSync(temp, recovery);
      } catch {
        throw new Error(
          "Another process is recovering the workspace lock. Retry shortly; workspace data is preserved.",
        );
      }
      try {
        const current = JSON.parse(readFileSync(path, "utf8"));
        if (current.nonce !== prior.nonce || !dead(current))
          throw new Error(
            "Workspace owner changed during recovery. Retry shortly.",
          );
        unlinkSync(path);
        linkSync(temp, path);
      } finally {
        unlinkSync(recovery);
      }
    }
  } finally {
    unlinkSync(temp);
  }
  return () => {
    try {
      if (JSON.parse(readFileSync(path, "utf8")).nonce === owner.nonce)
        unlinkSync(path);
    } catch {
      /* Never remove a replacement owner's lock. */
    }
  };
}
