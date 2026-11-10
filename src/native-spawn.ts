import {
  spawn,
  type SpawnOptions,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { isAbsolute } from "node:path";
import { observeNativeMemory } from "./native-memory.js";
import { own, killOwned, ownedGroupAlive } from "./process-records.js";

/** Optional host-owned resource launcher. It must exec the command with its
 * pipes, PID and process group intact; the browser cannot select this path. */
export function spawnHarnessProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
) {
  const launcher = process.env.LOOP_NATIVE_LAUNCHER;
  if (launcher && !isAbsolute(launcher))
    throw new Error(
      "LOOP_NATIVE_LAUNCHER must be an absolute executable path.",
    );
  const env = { ...(options.env ?? process.env) };
  // A harness runs arbitrary project commands. Importing that project's server
  // code must not inherit the host database, secrets or service identity and
  // migrate live data. Keep only the adapter's scoped tool/billing settings and
  // fixture controls.
  for (const key of Object.keys(env)) {
    const setting = /^LOOP_(.*)$/.exec(key)?.[1];
    if (
      setting !== undefined &&
      !setting.startsWith("TEST_") &&
      !["TOOLS_URL", "TOOLS_TOKEN", "BILLING_MODE"].includes(setting)
    )
      delete env[key];
  }
  const child = spawn(
    launcher || command,
    launcher ? [command, ...args] : args,
    {
      ...options,
      env,
      shell: false,
      detached: true,
    },
  ) as ChildProcessWithoutNullStreams;
  own(child);
  if (launcher) observeNativeMemory(child);
  return child;
}

const HARNESS_STOP_GRACE_MS = 2500;
const stops = new WeakMap<ChildProcess, Promise<void>>();

export function stopHarnessProcess(child?: ChildProcess): Promise<void> {
  if (!child?.pid) return Promise.resolve();
  const pending = stops.get(child);
  if (pending) return pending;
  const stopped = new Promise<void>((resolve) => {
    const timer = setTimeout(
      () => killOwned(child, "SIGKILL"),
      HARNESS_STOP_GRACE_MS,
    );
    let poll: ReturnType<typeof setTimeout> | undefined;
    // Neither a signal nor leader exit proves descendant writers stopped.
    const confirmStopped = () => {
      clearTimeout(poll);
      if (
        (child.exitCode !== null || child.signalCode !== null) &&
        !ownedGroupAlive(child)
      ) {
        clearTimeout(timer);
        child.removeListener("exit", confirmStopped);
        resolve();
      } else poll = setTimeout(confirmStopped, 1000);
    };
    child.once("exit", confirmStopped);
    child.stdin?.end();
    killOwned(child, "SIGTERM");
    confirmStopped();
  });
  stops.set(child, stopped);
  return stopped;
}
