import {
  linkSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
} from "node:fs";
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
/** Claim exactly this stale recovery record, so only one starter takes it over.
 * A leftover claim from a killed claimant is reclaimed; a live claimant's
 * claim refuses every later starter. */
function claimStale(temp: string, claim: string): boolean {
  for (;;) {
    try {
      linkSync(temp, claim);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let owner: Owner;
    try {
      owner = JSON.parse(readFileSync(claim, "utf8"));
    } catch {
      return false;
    }
    if (!dead(owner)) return false;
    // A dead claimant cannot finish its takeover; take over its claim. Two
    // starters that both observe the same dead claim can each unlink the
    // other's freshly re-linked claim; this residual needs a claimant killed
    // within a microsecond plus concurrent starts, and the surviving
    // claimant's verify-before-rename still holds, so it is at worst a
    // transient "still recovering" refusal.
    try {
      unlinkSync(claim);
    } catch {
      return false;
    }
  }
}
/**
 * Hold the recovery lock. A recoverer that was killed mid-recovery leaves its
 * record behind; a later starter takes over that dead record exclusively (via
 * a claim), so simultaneously starting recoverers can never both pass. The
 * record is replaced atomically, so `recovery` is never absent while a third
 * starter could claim the empty fast path.
 */
function takeRecovery(temp: string, recovery: string, nonce: string) {
  try {
    linkSync(temp, recovery);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let stale: Owner;
  try {
    stale = JSON.parse(readFileSync(recovery, "utf8"));
  } catch {
    throw new Error(RECOVERING);
  }
  if (!stale.identity || !stale.nonce || !dead(stale))
    throw new Error(RECOVERING);
  // Take over this specific stale record; never rename a record we do not own.
  const claim = recovery + ".stale." + stale.nonce;
  if (!claimStale(temp, claim)) throw new Error(RECOVERING);
  let tookOver = false;
  try {
    // Re-check the record is still the stale one we claimed (a live recoverer
    // may have replaced it; its nonce would differ and it is not dead).
    const current = JSON.parse(readFileSync(recovery, "utf8")) as Owner;
    if (current.nonce !== stale.nonce || !dead(current))
      throw new Error(RECOVERING);
    // Replace it atomically so `recovery` is never missing mid-takeover and a
    // third starter cannot grab the empty fast path. `temp` stays a hardlink.
    const mine = recovery + "." + nonce + ".new";
    linkSync(temp, mine);
    renameSync(mine, recovery);
    tookOver = true;
  } finally {
    // Release only a claim that is still ours. If a process is killed after the
    // rename but before this release, the orphan `.stale.<nonce>`/`.new` file is
    // harmless: the next starter either reclaims it (dead owner) or ignores it.
    // Release only a claim that is still ours.
    try {
      if ((JSON.parse(readFileSync(claim, "utf8")) as Owner).nonce === nonce)
        unlinkSync(claim);
    } catch {
      /* Already released or unreadable. */
    }
  }
  if (!tookOver) throw new Error(RECOVERING);
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
      takeRecovery(temp, recovery, owner.nonce);
      try {
        const current = JSON.parse(readFileSync(path, "utf8"));
        if (current.nonce !== prior.nonce || !dead(current))
          throw new Error(
            "Workspace owner changed during recovery. Retry shortly.",
          );
        unlinkSync(path);
        linkSync(temp, path);
      } finally {
        // Release only a recovery record that is still ours, never a newer
        // recoverer's.
        try {
          if (
            (JSON.parse(readFileSync(recovery, "utf8")) as Owner).nonce ===
            owner.nonce
          )
            unlinkSync(recovery);
        } catch {
          /* Already gone. */
        }
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
