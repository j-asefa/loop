import type { ChildProcess } from "node:child_process";

/** Only call for children launched detached by Loop: their process group is ours. */
export function killOwned(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}
