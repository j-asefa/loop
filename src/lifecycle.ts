import {
  linkSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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
    // EPERM: the PID is alive but belongs to another user, so it may have
    // been reused after a crash or reboot. Its identity below decides.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
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
const RECOVERING =
  "Another process is recovering the workspace lock. Retry shortly; workspace data is preserved.";
const UNREADABLE =
  "Workspace ownership record is unreadable. Preserve the state directory and inspect the lock; do not uninstall to recover.";
// randomUUID() nonces only: a nonce read from a file becomes part of a path.
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Mine = { temp: string; nonce: string };

/** The complete owner record at `path`, or why there is none. */
function ownerAt(path: string): Owner | "missing" | "invalid" {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "invalid";
  }
  try {
    const owner = JSON.parse(raw) as Owner;
    if (
      Number.isSafeInteger(owner?.pid) &&
      typeof owner.identity === "string" &&
      owner.identity &&
      typeof owner.nonce === "string" &&
      NONCE.test(owner.nonce)
    )
      return owner;
  } catch {
    /* Reported as invalid below. */
  }
  return "invalid";
}

/**
 * Every dead record is replaced only while holding its nonce's exclusive
 * claim. Claims share the root prefix, so repeated crashes grow neither paths
 * nor the call stack. Unwind only after acquiring the deepest claim.
 */
function acquire(root: string, mine: Mine, busy: string): void {
  const parents: { path: string; nonce: string }[] = [];
  const visited = new Set<string>();
  let path = root;
  while (true) {
    if (visited.has(path)) throw new Error(UNREADABLE);
    visited.add(path);
    let stale: Owner | undefined;
    let acquired = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(mine.temp, path);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const current = ownerAt(path);
      if (current === "missing") continue;
      if (current === "invalid") throw new Error(UNREADABLE);
      if (!dead(current)) throw new Error(path === root ? busy : RECOVERING);
      stale = current;
      break;
    }
    if (acquired) break;
    if (!stale) throw new Error(RECOVERING);
    parents.push({ path, nonce: stale.nonce });
    path = root + ".stale." + stale.nonce;
  }

  // `path` is the claim we own. At each step transfer ownership to its
  // parent before releasing it. A killed starter leaves a recoverable record.
  try {
    while (parents.length) {
      const parent = parents.pop()!;
      const current = ownerAt(parent.path);
      if (
        current === "missing" ||
        current === "invalid" ||
        current.nonce !== parent.nonce
      )
        throw new Error(RECOVERING);
      const next = root + "." + mine.nonce + ".new";
      try {
        linkSync(mine.temp, next);
        renameSync(next, parent.path);
      } finally {
        try {
          unlinkSync(next);
        } catch {
          /* Renamed into place, or never created. */
        }
      }
      release(path, mine.nonce);
      path = parent.path;
    }
  } catch (error) {
    release(path, mine.nonce);
    throw error;
  }
}

/** Remove `path` only while it still holds our own record. */
function release(path: string, nonce: string) {
  const current = ownerAt(path);
  if (current !== "missing" && current !== "invalid" && current.nonce === nonce)
    try {
      unlinkSync(path);
    } catch {
      /* Already gone. */
    }
}

/**
 * Once we hold `path`, markers from killed starters are dead weight: claims
 * named for records `path` no longer holds can never matter again, and temp
 * or rename files whose owner is dead have no one to finish them.
 */
function removeLeftovers(path: string) {
  const dir = dirname(path),
    prefix = basename(path) + ".";
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return;
  }
  for (const name of names.slice(0, 64)) {
    const rest = name.slice(prefix.length);
    const file = join(dir, name);
    try {
      if (rest.startsWith("stale.")) unlinkSync(file);
      else if (NONCE.test(rest.replace(/\.new$/, ""))) {
        const owner = ownerAt(file);
        if (owner !== "missing" && owner !== "invalid" && dead(owner))
          unlinkSync(file);
      }
    } catch {
      /* Best effort; never affects the lock we hold. */
    }
  }
}

const WORKSPACE_LOCK = {
  name: "host.lock",
  owner:
    "Another Loop host is starting or running. Wait for it, then run loop again; no process was stopped.",
};
/** Complete records are installed atomically; a dead owner's lock is replaced through an exclusive claim. */
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
    acquire(path, { temp, nonce: owner.nonce }, lock.owner);
  } finally {
    unlinkSync(temp);
  }
  removeLeftovers(path);
  return () => release(path, owner.nonce);
}
