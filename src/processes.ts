import type { ChildProcess } from "node:child_process";
import { identity } from "./lifecycle.js";
import { atomic } from "./state.js";
import { groupAlive, groupMembers, processState } from "./daemon.js";
const identities = new WeakMap<ChildProcess, string>();

/** Only call for children launched detached by Loop: their process group is ours. */
export function killOwned(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  const recorded = identities.get(child), live = identity(child.pid);
  if (recorded && live && recorded !== live) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

// Detached children run in their own process groups and outlive a killed
// workspace, so the workspace records them for a forced `loop stop`.
let registry: string | undefined;
const owned = new Map<number, string>();
let stopping = false;
export function stopOwnedProcessLaunches() { stopping = true; }
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
/** Records a child launched detached by Loop until it exits. */
export function own(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  const start = identity(pid) ?? "";
  identities.set(child, start);
  owned.set(pid, start);
  persist();
  child.once("exit", () => {
    // A detached leader can exit before its descendants. Retain that record
    // so recovery refuses an unidentifiable surviving group instead of
    // silently launching a second native writer.
    if (!groupAlive(pid)) owned.delete(pid);
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
  const members = () => groupMembers(process.pid).filter(pid => pid !== process.pid);
  const end = Date.now() + 2000;
  let signal: NodeJS.Signals = "SIGTERM";
  while (members().length) {
    for (const pid of members()) {
      const recorded = { pid, identity: identity(pid) || "" };
      if (processState(recorded) === "running" && members().includes(pid)) {
        try { process.kill(pid, signal); } catch { /* exited */ }
      }
    }
    if (Date.now() >= end) throw new Error("Worker subprocesses did not stop; ownership records are retained.");
    await new Promise(resolve => setTimeout(resolve, 100));
    signal = "SIGKILL";
  }
}
