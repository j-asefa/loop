import "../../deployment/environment.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function startSmokeTrace(context, name) {
  const directory = process.env.LOOP55_BROWSER_TRACE_DIR;
  if (!directory) return async () => {};
  mkdirSync(directory, { recursive: true });
  await context.tracing.start({ screenshots: true, snapshots: true });
  return async (failed) => {
    const path = join(directory, `${name}-${process.pid}.zip`);
    await context.tracing.stop(failed ? { path } : {});
    if (failed) console.error(`Browser failure trace: ${path}`);
  };
}

export function reportSmokePressure() {
  if (process.platform !== "linux") return;
  try {
    const group = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    if (!group) return;
    const directory = join("/sys/fs/cgroup", group);
    for (const metric of [
      "memory.current",
      "memory.events",
      "memory.pressure",
      "cpu.pressure",
    ]) {
      try {
        console.error(
          `Smoke cgroup ${metric}: ${readFileSync(join(directory, metric), "utf8").trim().replaceAll("\n", "; ")}`,
        );
      } catch {
        /* Not every controller is exposed in every environment. */
      }
    }
  } catch {
    /* Diagnostics must not replace the original failure. */
  }
}
