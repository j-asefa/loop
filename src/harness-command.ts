import { spawnHarnessProcess, stopHarnessProcess } from "./native-spawn.js";
import { killOwned, ownedGroupAlive } from "./process-records.js";

/** Bounded command output; failures retain stdout for native auth-status JSON. */
export function runHarnessCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    killSignal?: "SIGTERM" | "SIGKILL";
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnHarnessProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let outBytes = 0,
      errBytes = 0;
    let failure: Error | undefined;
    let killed = false;
    const abort = (error: Error) => {
      if (failure) return;
      failure = error;
      killed = true;
      if (options.killSignal === "SIGKILL") killOwned(child, "SIGKILL");
      void stopHarnessProcess(child);
    };
    const capture = (chunks: Buffer[], used: number, chunk: Buffer) => {
      const available = Math.max(0, options.maxBuffer - used);
      if (available) chunks.push(chunk.subarray(0, available));
      if (chunk.length > available)
        abort(new Error("Harness command output exceeded its limit."));
      return used + Math.min(available, chunk.length);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes = capture(stdout, outBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes = capture(stderr, errBytes, chunk);
    });
    const timer = setTimeout(
      () => abort(new Error("Harness command timed out.")),
      options.timeout,
    );
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (ownedGroupAlive(child)) {
        killed = true;
        failure ??= new Error("Harness command left running subprocesses.");
      }
      void stopHarnessProcess(child).then(() => {
        const output = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (failure || code !== 0)
          reject(
            Object.assign(
              failure ??
                new Error(`Harness command exited (${signal ?? code}).`),
              output,
              {
                killed,
                signal,
                code: (failure as NodeJS.ErrnoException)?.code ?? code,
              },
            ),
          );
        else resolve(output);
      }, reject);
    });
  });
}
