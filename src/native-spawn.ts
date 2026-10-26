import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

/** Optional host-owned resource launcher. It must exec the command with its
 * pipes, PID and process group intact; the browser cannot select this path. */
export function spawnNative(command: string, args: string[], options: SpawnOptions) {
  const launcher = process.env.LOOP_NATIVE_LAUNCHER;
  if (launcher && !isAbsolute(launcher))
    throw new Error("LOOP_NATIVE_LAUNCHER must be an absolute executable path.");
  const env = { ...(options.env ?? process.env) };
  delete env.LOOP_SERVICE;
  // Descendants already inherit the resource group. A nested fixture workspace
  // must not take over the host's service or create a second resource scope.
  delete env.LOOP_NATIVE_LAUNCHER;
  return spawn(launcher || command, launcher ? [command, ...args] : args, {
    ...options, env, shell: false,
  }) as ChildProcessWithoutNullStreams;
}
