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
  // Old service settings must not restore automatic host-wide test admission.
  const shims = [env.LOOP_JOB_SHIMS, process.env.LOOP_JOB_SHIMS].filter(
    (path): path is string => Boolean(path && isAbsolute(path)),
  );
  if (shims.length)
    env.PATH = (env.PATH ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter((path) => !shims.some((shim) => resolve(path) === resolve(shim)))
      .join(delimiter);
  // A harness runs arbitrary project commands. Importing that project's server
  // code must not inherit the host database, secrets or service identity and
  // migrate live data. Keep only the adapter's scoped tool/billing settings and
  // fixture controls. Settings left over from the Loop55 name never pass.
  for (const key of Object.keys(env)) {
    const [, stale, setting] = /^LOOP(55)?_(.*)$/.exec(key) ?? [];
    if (
      setting !== undefined &&
      (stale ||
        (!setting.startsWith("TEST_") &&
          !["TOOLS_URL", "TOOLS_TOKEN", "BILLING_MODE"].includes(setting)))
    )
      delete env[key];
  }
  delete env.BETTER_AUTH_SECRET;
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
