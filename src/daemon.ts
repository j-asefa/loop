import { openSync, closeSync, writeSync, renameSync, fstatSync } from "node:fs";
import { stat, readFile, writeFile, chmod, rm, open } from "node:fs/promises";
import { join } from "node:path";
import {
  identity,
  alive,
  processState,
  groupMembers,
  recordedGroupAlive,
  leadsGroup,
  type Recorded,
} from "./process-records.js";
import { atomic } from "./state.js";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const PAIRING_SECRET = /#(pair|fleet)=[\w-]+/g;

/**
 * Routes this process's stdout and stderr into a log capped at maxBytes, with
 * one previous file kept as `.1`. Writes are synchronous, so rotating (rename,
 * then reopen) between two writes never drops or splits a line. A single write
 * larger than the cap is kept whole.
 */
export function installDaemonLog(path: string, maxBytes = LOG_MAX_BYTES) {
  let fd = openSync(path, "a", 0o600);
  let size = fstatSync(fd).size;
  // Set once the current file has become `.1`, until a new file is opened.
  let renamed = false;
  const rotate = () => {
    size = 0;
    try {
      if (!renamed) renameSync(path, path + ".1");
      renamed = true;
      const next = openSync(path, "a", 0o600);
      closeSync(fd);
      fd = next;
      renamed = false;
    } catch (e) {
      // Keep writing to the open file rather than losing output, and retry
      // once another maxBytes has been written.
      writeSync(
        fd,
        `Loop: could not rotate ${path} (${(e as Error).message}); logging continues in the current file.\n`,
      );
    }
  };
  const write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    done?: (error?: Error | null) => void,
  ) => {
    const data =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
        : chunk;
    try {
      if (size > 0 && size + data.length > maxBytes) rotate();
      writeSync(fd, data);
      size += data.length;
    } catch {
      // Losing a log line must never take the workspace down.
    }
    const callback = typeof encoding === "function" ? encoding : done;
    if (callback) queueMicrotask(() => callback());
    return true;
  };
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
  // Node prints a fatal exception straight to fd 2, which still points at the
  // file first opened (by now possibly `.1` or deleted), so log it here too.
  // Native fatal errors (such as running out of memory) still bypass this.
  process.on("uncaughtExceptionMonitor", (error) =>
    write(`${(error as Error)?.stack ?? error}\n`),
  );
}

/**
 * Moves the previous run's log to `.1` with pairing secrets redacted, so a
 * fresh 0600 log starts each launch. Keep only its last LOG_MAX_BYTES.
 */
export async function retireLog(path: string) {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return;
  let previous: string;
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - LOG_MAX_BYTES);
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(size - start),
      0,
      size - start,
      start,
    );
    previous = buffer.subarray(0, bytesRead).toString("utf8");
    // Drop a partial first line, which could hold a cut-off secret.
    if (start > 0) {
      const line = previous.indexOf("\n");
      previous = line < 0 ? "" : previous.slice(line + 1);
    }
  } finally {
    await file.close();
  }
  await writeFile(
    path + ".1",
    previous.replace(PAIRING_SECRET, "#$1=<redacted>"),
    { mode: 0o600 },
  );
  await chmod(path + ".1", 0o600);
  await rm(path, { force: true });
}

const valid = (r: unknown): r is Recorded =>
  !!r &&
  Number.isSafeInteger((r as Recorded).pid) &&
  // Never 1: signalling -1 would reach every process we may signal.
  (r as Recorded).pid > 1 &&
  typeof (r as Recorded).identity === "string";
async function readJson(path: string): Promise<unknown> {
  return readFile(path, "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
}

/**
 * The workspace process that has not cleaned up after itself: control.json is
 * removed on shutdown, and host.lock holds the process identity. A stale lock
 * alone is left for workspaceLock's own recovery.
 */
export async function recordedWorkspace(dir: string) {
  const [control, owner] = await Promise.all([
    stat(join(dir, "control.json")).catch(() => undefined),
    readJson(join(dir, "host.lock")),
  ]);
  if (!control || !valid(owner)) return undefined;
  return {
    pid: owner.pid,
    identity: owner.identity,
    state: processState(owner),
  };
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
    const kept = await readRecords(join(dir, STOP_RECORDS));
    atomic(join(dir, STOP_RECORDS), [...kept, ...members]);
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

// Written only by `loop stop`, so it outlives the workspace's own registry
// (children.json), which a restarted workspace also starts afresh.
const STOP_RECORDS = "stop-records.json";
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
    ...(await readRecords(join(dir, "children.json"))),
    ...(await readRecords(join(dir, STOP_RECORDS))),
    // A companion worker owns detached native children in its own registry.
    // Keep them reachable by loop stop even if both API and worker crashed.
    ...(await readRecords(join(dir, "execution", "children.json"))),
    ...(await readRecords(join(dir, "execution", STOP_RECORDS))),
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
  atomic(join(dir, STOP_RECORDS), records);
  await Promise.all(
    ["control.json", "children.json"].map((f) =>
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
      "control.json",
      "children.json",
      STOP_RECORDS,
      "execution/children.json",
      "execution/" + STOP_RECORDS,
    ].map((f) => rm(join(dir, f), { force: true })),
  );
}
