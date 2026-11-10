import {
  readFileSync,
  readdirSync,
  readlinkSync,
  linkSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { execFileSync, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomic } from "./state.js";

export const PROCESS_FILES = {
  control: "control.json",
  children: "children.json",
  // Stop obligations must outlive replacement of a workspace child registry.
  stop: "stop-records.json",
  lock: "host.lock",
  log: "daemon.log",
  preferences: "preferences.json",
  launch: "launch.json",
  execution: "execution",
  executionOwner: "owner.json",
} as const;

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
function leadsGroup(pid: number) {
  const state = signalState(-pid);
  return state === "present" || state === "denied";
}

function recordedProcessDead(owner: Recorded) {
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

const identities = new WeakMap<
  ChildProcess,
  {
    identity: string;
    scope: "process" | "group";
  }
>();

// A PID alone cannot authorize a signal: without a launch identity an exited
// leader's surviving group cannot be distinguished from a replacement group.
export function killOwned(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return false;
  const recorded = identities.get(child);
  if (!recorded) return false;
  // Node retains the direct child's handle until exit; missing launch evidence
  // must not promote that handle into authority over a whole process group.
  if (!recorded.identity) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    return child.kill(signal);
  }
  const live = identity(child.pid);
  if (live && recorded.identity !== live) return false;
  if (recorded.scope === "process") {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    return child.kill(signal);
  }
  try {
    return process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      return child.kill(signal);
    return false;
  }
}

export function ownedGroupAlive(child: ChildProcess) {
  const recorded = identities.get(child);
  return (
    recorded?.scope === "group" &&
    !!child.pid &&
    recordedGroupAlive({
      pid: child.pid,
      identity: recorded.identity,
    })
  );
}

// Detached children run in their own process groups and outlive a killed
// workspace, so the workspace records them for a forced `loop stop`.
let registry: string | undefined;
const owned = new Map<number, string>();
let stopping = false;
export function stopOwnedProcessLaunches() {
  stopping = true;
}
function persist() {
  if (registry)
    atomic(
      registry,
      [...owned].map(([pid, id]) => ({ pid, identity: id })),
    );
}
export function recordOwnedProcesses(path: string) {
  registry = path;
  persist();
}
/** "group" records a detached leader and its descendants; "process" records
 * an attached child such as cloudflared, without claiming its parent's group. */
export function recordOwnedChild(
  child: ChildProcess,
  scope: "process" | "group",
) {
  const pid = child.pid;
  if (!pid) return;
  const start = identity(pid) ?? "";
  identities.set(child, { identity: start, scope });
  owned.set(pid, start);
  persist();
  child.once("exit", () => {
    // A detached leader can exit before its descendants. Retain that record
    // so recovery refuses an unidentifiable surviving group instead of
    // silently launching a second native writer.
    if (scope === "process" || !groupAlive(pid)) owned.delete(pid);
    persist();
  });
  if (stopping) {
    killOwned(child, "SIGKILL");
    throw new Error("Execution worker is stopping.");
  }
}

/** The worker is a process-group leader. Stop its non-detached subprocesses
 * while that leader still proves ownership; detached natives use the registry. */
export async function stopAttachedChildren() {
  const members = () =>
    groupMembers(process.pid).filter((pid) => pid !== process.pid);
  const end = Date.now() + 2000;
  let signal: NodeJS.Signals = "SIGTERM";
  while (members().length) {
    for (const pid of members()) {
      const recorded = { pid, identity: identity(pid) || "" };
      if (processState(recorded) === "running" && members().includes(pid)) {
        try {
          process.kill(pid, signal);
        } catch {
          /* exited */
        }
      }
    }
    if (Date.now() >= end)
      throw new Error(
        "Worker subprocesses did not stop; ownership records are retained.",
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
    signal = "SIGKILL";
  }
}

type Owner = Recorded & { nonce: string };
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
      if (!recordedProcessDead(current))
        throw path === root ? new LockBusyError(busy) : new Error(RECOVERING);
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
        if (
          owner !== "missing" &&
          owner !== "invalid" &&
          recordedProcessDead(owner)
        )
          unlinkSync(file);
      }
    } catch {
      /* Best effort; never affects the lock we hold. */
    }
  }
}

export class LockBusyError extends Error {
  static readonly code = "LOOP_LOCK_BUSY";
  readonly code = LockBusyError.code;
}

const WORKSPACE_LOCK = {
  name: PROCESS_FILES.lock,
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

const valid = (r: unknown): r is Recorded =>
  !!r &&
  Number.isSafeInteger((r as Recorded).pid) &&
  // Never 1: signalling -1 would reach every process we may signal.
  (r as Recorded).pid > 1 &&
  typeof (r as Recorded).identity === "string";
export class ProcessRecordError extends Error {}

type RecordRead<T> =
  | { state: "absent" }
  | { state: "invalid"; error: ProcessRecordError }
  | { state: "present"; record: T };

async function readRecord<T>(
  path: string,
  accepts: (value: unknown) => value is T,
  description: string,
): Promise<RecordRead<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "absent" };
    return {
      state: "invalid",
      error: new ProcessRecordError(
        `Unreadable ${description}. Preserve the state directory and inspect the record.`,
      ),
    };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (accepts(value)) return { state: "present", record: value };
  } catch {
    /* malformed JSON */
  }
  return {
    state: "invalid",
    error: new ProcessRecordError(
      `Invalid ${description}. Preserve the state directory and inspect the record.`,
    ),
  };
}

type ControlRecord = { port: number; token: string };
export function readControlRecord(dir: string) {
  return readRecord(
    join(dir, PROCESS_FILES.control),
    (value): value is ControlRecord => {
      if (!value || typeof value !== "object") return false;
      const record = value as ControlRecord;
      return (
        Number.isInteger(record.port) &&
        record.port > 0 &&
        record.port <= 65535 &&
        typeof record.token === "string"
      );
    },
    "local host record",
  );
}

/** A stale lock without a control record belongs to workspaceLock's recovery. */
export async function recordedWorkspace(dir: string) {
  const control = await readControlRecord(dir);
  if (control.state !== "present") return control;
  const owner = await readRecord(
    join(dir, PROCESS_FILES.lock),
    valid,
    "workspace ownership record",
  );
  if (owner.state === "invalid") return owner;
  if (owner.state === "absent") {
    // Shutdown removes control before releasing the lock. The first control
    // read may have completed just before those two removals.
    const current = await readControlRecord(dir);
    if (current.state !== "present") return current;
    return {
      state: "invalid" as const,
      error: new ProcessRecordError(
        "Missing workspace ownership record. Preserve the state directory and inspect the record.",
      ),
    };
  }
  return { ...owner.record, state: processState(owner.record) };
}

/**
 * Stops a workspace (if still running), its own process group including the
 * tunnel, and the detached native process groups it recorded, even after the
 * workspace itself crashed. Each target is confirmed by identity first. A
 * confirmed group stays ours until it is empty, because its ID can't be reused
 * while any member lives, so members that outlive their leader are still
 * stopped and reported, and are recorded for any later attempt. A recorded
 * group whose leader had already exited can't be confirmed, so it is left
 * alone and reported as unresolved.
 */
export async function terminateWorkspace(
  dir: string,
  workspace: Recorded | undefined,
  graceMs: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
) {
  const children = await recordedChildren(dir);
  const targets = [...(workspace ? [workspace] : []), ...children]
    .filter((t) => processState(t) === "running")
    .map((t) => ({ ...t, group: leadsGroup(t.pid) }));
  // A group is only known to be ours while its confirmed leader lives. Record
  // its other members first, so a later attempt can still confirm and stop any
  // that outlive the leader, even if this one is interrupted.
  // They go in the stop's own file: a live workspace rewrites children.json
  // whenever one of its children exits.
  const members = targets
    .filter((t) => t.group)
    .flatMap((t) =>
      groupMembers(t.pid)
        .filter((pid) => pid !== t.pid)
        .flatMap((pid) => {
          // Read the identity, then check the PID is still in the group, so a
          // PID recycled in between isn't recorded as ours.
          const id = identity(pid);
          return id &&
            !children.some((c) => c.pid === pid && c.identity === id) &&
            groupMembers(t.pid).includes(pid)
            ? [{ pid, identity: id }]
            : [];
        }),
    );
  if (members.length) {
    const kept = await readRecords(join(dir, PROCESS_FILES.stop));
    atomic(join(dir, PROCESS_FILES.stop), [...kept, ...members]);
  }
  // Identity is confirmed right before each signal (a PID reused in the instant
  // between that check and the signal can't be excluded) and for the final
  // report; waiting in between only polls liveness (identity() runs ps on macOS).
  const running = () =>
    targets.filter((t) =>
      t.group ? recordedGroupAlive(t) : processState(t) === "running",
    );
  const present = () =>
    targets.some((t) => (t.group ? recordedGroupAlive(t) : alive(t.pid)));
  const signal = (sig: NodeJS.Signals) => {
    for (const t of running())
      try {
        kill(t.group ? -t.pid : t.pid, sig);
      } catch {
        /* Already gone. */
      }
  };
  const settle = async () => {
    const end = Date.now() + graceMs;
    while (present() && Date.now() < end)
      await new Promise((r) => setTimeout(r, 100));
  };
  signal("SIGTERM");
  await settle();
  signal("SIGKILL");
  await settle();
  // Records that can't be confirmed (or whose leader exited, leaving a group
  // that can no longer be tied to it) were not signalled, and aren't finished.
  const unresolved = children.filter((c) => {
    const state = processState(c);
    return state === "unknown" || (state === "exited" && recordedGroupAlive(c));
  });
  return { unresolved, survivors: running().map((t) => t.pid) };
}

async function readRecords(path: string) {
  try {
    const recorded: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(recorded) || !recorded.every(valid))
      throw new Error("Invalid process record");
    return recorded as Recorded[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `Process records are unreadable at ${path}. Preserve the file and inspect it before stopping or restarting.`,
      { cause: error },
    );
  }
}
/** The workspace's recorded native processes plus any a stop still owes. */
export async function recordedChildren(dir: string) {
  const all = [
    ...(await readRecords(join(dir, PROCESS_FILES.children))),
    ...(await readRecords(join(dir, PROCESS_FILES.stop))),
    // A companion worker owns detached native children in its own registry.
    // Keep them reachable by loop stop even if both API and worker crashed.
    ...(await readRecords(
      join(dir, PROCESS_FILES.execution, PROCESS_FILES.children),
    )),
    ...(await readRecords(
      join(dir, PROCESS_FILES.execution, PROCESS_FILES.stop),
    )),
  ];
  const seen = new Set<string>();
  return all.filter((record) => {
    // Different lifetimes can share a PID. Retaining the stale identity must
    // never hide a current process recorded by the execution owner.
    const key = JSON.stringify([record.pid, record.identity]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The workspace is gone, but these records stay for a later `loop stop`. */
export async function keepUnresolved(dir: string, records: Recorded[]) {
  atomic(join(dir, PROCESS_FILES.stop), records);
  await Promise.all(
    [PROCESS_FILES.control, PROCESS_FILES.children].map((f) =>
      rm(join(dir, f), { force: true }),
    ),
  );
}

export async function forgetWorkspace(dir: string) {
  // Revalidate after shutdown: a writer may have updated its registry while
  // the first stop attempt was waiting. Never erase new or malformed evidence.
  const records = await recordedChildren(dir);
  if (
    records.some(
      (record) =>
        processState(record) !== "exited" || recordedGroupAlive(record),
    )
  )
    throw new Error(
      "Recorded processes remain unconfirmed. Their records were kept; run loop stop again.",
    );
  await Promise.all(
    [
      PROCESS_FILES.control,
      PROCESS_FILES.children,
      PROCESS_FILES.stop,
      join(PROCESS_FILES.execution, PROCESS_FILES.children),
      join(PROCESS_FILES.execution, PROCESS_FILES.stop),
    ].map((f) => rm(join(dir, f), { force: true })),
  );
}
