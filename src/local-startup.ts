import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isEntrypoint(
  url: string,
  options: { unresolved?: "lexical" | "reject" } = {},
) {
  try {
    return (
      !!process.argv[1] &&
      url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    // The CLI may already be loaded while an upgrade replaces its entry file.
    return (
      options.unresolved === "lexical" &&
      !!process.argv[1] &&
      url === pathToFileURL(process.argv[1]).href
    );
  }
}

export function reportReady(message: object) {
  if (typeof process.send !== "function" || !process.connected) return;
  process.send(message, () => {
    if (process.connected) process.disconnect?.();
  });
}

export async function spawnReady<T>(
  entry: string,
  args: string[],
  log: string,
  options: {
    execArgv?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout: number;
    timeoutMessage: string;
    exitMessage: (code: number | null) => string;
    readMessage: (message: any) => T;
    forwardSignals?: boolean;
  },
): Promise<T> {
  const fd = openSync(log, "a", 0o600);
  let child: ChildProcess;
  try {
    // A detached service must survive application-group shutdown and terminal exit.
    child = spawn(
      process.execPath,
      [...(options.execArgv ?? process.execArgv), entry, ...args],
      {
        detached: true,
        stdio: ["ignore", fd, fd, "ipc"],
        cwd: options.cwd,
        env: options.env,
      },
    );
  } finally {
    closeSync(fd);
  }
  const abort = () => {
    child.kill("SIGTERM");
  };
  if (options.forwardSignals) {
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(options.timeoutMessage));
      }, options.timeout);
      child.once("message", (message) => {
        try {
          resolve(options.readMessage(message));
        } catch (error) {
          reject(error);
        }
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(options.exitMessage(code))),
      );
    });
  } finally {
    clearTimeout(timer);
    if (options.forwardSignals) {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
    child.removeAllListeners();
    if (child.connected) child.disconnect();
    child.unref();
  }
}
