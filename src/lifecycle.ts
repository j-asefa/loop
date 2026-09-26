import { linkSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { atomic } from "./state.js";

function identity(pid: number): string | undefined {
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
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim() || undefined
    );
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
  const live = identity(owner.pid);
  return !!live && live !== owner.identity;
}
/** Complete records are installed atomically. A separate recovery lock serializes stale takeover. */
export function workspaceLock(dir: string): () => void {
  const path = join(dir, "host.lock");
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
        throw new Error(
          "Another Loop host is starting or running. Wait for it, then run loop again; no process was stopped.",
        );
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
