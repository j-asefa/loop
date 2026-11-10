import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Linux comm is parenthesized but may itself contain spaces and parentheses.
// Only the last closing parenthesis ends it; field offsets start at state.
function procStat(pid: number) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = raw.lastIndexOf(")");
  if (end < 0) throw new Error("Invalid process stat");
  const fields = raw
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const [state, , group] = fields;
  const start = fields[19];
  if (!state || !/^\d+$/.test(group ?? "") || !/^\d+$/.test(start ?? ""))
    throw new Error("Invalid process stat");
  return { state, group: Number(group), start };
}

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
      const stat = procStat(pid);
      return (
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() +
        ":" +
        stat.start
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
function signalState(pid: number): "present" | "absent" | "denied" | "unknown" {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH"
      ? "absent"
      : code === "EPERM"
        ? "denied"
        : "unknown";
  }
}
function zombie(pid: number) {
  if (process.platform !== "linux") return false;
  try {
    return procStat(pid).state === "Z";
  } catch {
    return false;
  }
}
export function alive(pid: number) {
  const state = signalState(pid);
  return state === "denied" || (state === "present" && !zombie(pid));
}

export async function exited(pid: number, ms: number) {
  const end = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

export type Recorded = { pid: number; identity: string };
/**
 * Whether a recorded process is still that process. A live PID that can't be
 * identified is "unknown": never assume it is ours.
 */
export function processState(r: Recorded): "running" | "exited" | "unknown" {
  if (!alive(r.pid)) return "exited";
  const state = processIdentityState(r.pid, r.identity);
  return state === "same"
    ? "running"
    : state === "different"
      ? "exited"
      : "unknown";
}

// Live (non-zombie) members of a process group. Linux reads /proc so an
// unreaped zombie can't keep a finished group looking alive.
export function groupMembers(pgid: number): number[] {
  if (process.platform !== "linux") {
    try {
      return (
        execFileSync("ps", ["-A", "-o", "pid=,pgid="], {
          encoding: "utf8",
          timeout: 3000,
        })
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number))
          .filter(([, group]) => group === pgid)
          .map(([pid]) => pid)
          // When inspecting our own group, ps itself appears in its output
          // but has exited by the time execFileSync returns.
          .filter(alive)
      );
    } catch {
      return [];
    }
  }
  const members: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const { state, group: pgrp } = procStat(Number(entry));
      if (pgrp === pgid && state !== "Z") members.push(Number(entry));
    } catch {
      /* The process exited while listing. */
    }
  }
  return members;
}
export function groupAlive(pgid: number) {
  if (process.platform === "linux") return groupMembers(pgid).length > 0;
  return leadsGroup(pgid);
}
/** POSIX prevents reallocating a PID while that ID still names a process group.
 * A different readable identity proves that this record's old group is gone;
 * the replacement group must neither block recovery nor receive its signals. */
export function recordedGroupAlive(record: Recorded) {
  if (
    (process.platform === "linux" || process.platform === "darwin") &&
    record.identity
  ) {
    if (processIdentityState(record.pid, record.identity) === "different")
      return false;
  }
  return groupAlive(record.pid);
}
export function leadsGroup(pid: number) {
  const state = signalState(-pid);
  return state === "present" || state === "denied";
}

export function recordedProcessDead(owner: Recorded) {
  const state = signalState(owner.pid);
  if (state === "absent") return true;
  // A lock is recovered only with positive evidence of death or PID reuse.
  // EPERM still permits identity checks; other probe failures are inconclusive.
  if (state === "unknown") return false;
  return (
    zombie(owner.pid) ||
    processIdentityState(owner.pid, owner.identity) === "different"
  );
}
