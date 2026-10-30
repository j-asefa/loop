import {
  spawn,
  type SpawnOptions,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { delimiter, isAbsolute, resolve } from "node:path";
import { observeNativeMemory } from "./native-memory.js";

/** Optional host-owned resource launcher. It must exec the command with its
 * pipes, PID and process group intact; the browser cannot select this path. */
export function spawnNative(
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
  delete env.LOOP_SERVICE;
  // Descendants already inherit the resource group. A nested fixture workspace
  // must not take over the host's service or create a second resource scope.
  delete env.LOOP_NATIVE_LAUNCHER;
  // Old service settings must not restore automatic host-wide test admission.
  const shims = [env.LOOP_JOB_SHIMS, process.env.LOOP_JOB_SHIMS].filter(
    (path): path is string => Boolean(path && isAbsolute(path)),
  );
  if (shims.length)
    env.PATH = (env.PATH ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter((path) => !shims.some((shim) => resolve(path) === resolve(shim)))
      .join(delimiter);
  delete env.LOOP_JOB_QUEUE_CONFIG;
  delete env.LOOP_JOB_SHIMS;
  delete env.LOOP_JOB_ACTIVE;
  env.LOOP_HEAVY_SCHEDULING = "off";
  const child = spawn(
    launcher || command,
    launcher ? [command, ...args] : args,
    {
      ...options,
      env,
      shell: false,
    },
  ) as ChildProcessWithoutNullStreams;
  if (launcher) observeNativeMemory(child);
  return child;
}
