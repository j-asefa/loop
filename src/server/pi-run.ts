import { ownedGroupAlive } from "../processes.js";
import { spawnHarnessProcess, stopHarnessProcess } from "../native-spawn.js";

/**
 * Runs a Pi package command (install, remove, update). Pi passes npm and git
 * output straight through, which can be long, so stdout is discarded and only
 * the tail of stderr is kept: a buffer limit would kill Pi partway through an
 * install. A failure carries Pi's own error line.
 */
export function runPi(
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawnHarnessProcess(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-4096);
    });
    const timer = setTimeout(
      () => void stopHarnessProcess(child),
      options.timeout ?? 120_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const survivors = ownedGroupAlive(child);
      void stopHarnessProcess(child).then(() => {
        if (code === 0 && !survivors) resolve();
        else
          reject(
            new Error(
              piErrorLine(tail) ||
                (survivors
                  ? "Pi left running subprocesses."
                  : signal
                    ? `Pi stopped (${signal}).`
                    : `Pi exited with code ${code}.`),
            ),
          );
      }, reject);
    });
  });
}

/** The last line Pi reported as an error, with URL credentials removed. */
export function piErrorLine(stderr: string) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line =
    lines.findLast((candidate) => /error/i.test(candidate)) || lines.at(-1);
  return line?.replace(/\/\/[^/\s@]+@/g, "//").slice(0, 300) || "";
}
