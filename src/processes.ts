import type { ChildProcess } from "node:child_process";
import { identity } from "./lifecycle.js";
import { atomic } from "./state.js";

/** Only call for children launched detached by Loop: their process group is ours. */
export function killOwned(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
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
  owned.set(pid, identity(pid) ?? "");
  persist();
  child.once("exit", () => {
    owned.delete(pid);
    persist();
  });
}
