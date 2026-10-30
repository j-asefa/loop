// Supervise command lifetimes without serializing independent invocations.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function runSupervised(command, args, options = {}) {
  const {
    label = "command",
    stdio = "inherit",
    cwd,
    env = process.env,
    signal,
    log = (line) => process.stderr.write(line + "\n"),
  } = options;
  if (signal?.aborted) return 130;
  const supervised = process.platform === "linux";
  const config = { label, parentPid: process.pid };
  return new Promise((resolve) => {
    const child = spawn(
      supervised ? "python3" : command,
      supervised
        ? [
            fileURLToPath(new URL("./heavy-supervisor.py", import.meta.url)),
            JSON.stringify(config),
            command,
            ...args,
          ]
        : args,
      {
        cwd,
        env,
        stdio: supervised ? [stdio, stdio, stdio, "pipe"] : stdio,
      },
    );
    let lines = "";
    child.stdio[3]?.on("data", (data) => {
      lines += data;
      let end;
      while ((end = lines.indexOf("\n")) !== -1) {
        log(lines.slice(0, end));
        lines = lines.slice(end + 1);
      }
    });
    const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((name) => [
      name,
      () => child.kill(name),
    ]);
    const abort = () => child.kill("SIGTERM");
    for (const [name, handler] of handlers) process.on(name, handler);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => {
      for (const [name, handler] of handlers) process.off(name, handler);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      log(
        `${label}: not started: ${error.message}${supervised ? "; Linux command supervision requires Python 3.8+" : ""}`,
      );
      resolve(127);
    });
    child.once("close", (code, killedBy) => {
      cleanup();
      if (lines) log(lines);
      resolve(code ?? 128 + (constants.signals[killedBy] ?? 1));
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (!args.length)
    throw new Error(
      "Usage: node scripts/heavy-command.mjs [node options] script [arguments]",
    );
  process.exitCode = await runSupervised(process.execPath, args, {
    label: "browser smoke",
  });
}
