// Cooperative admission for repository checks. The Linux supervisor retains
// the lock until the entire command tree has exited, including orphaned children.
import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { constants, homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SLOT_BUSY_EXIT = 75;

export function watchRequested(args) {
  let watch = false;
  for (let i = 0; i < args.length; i++) {
    if (["--watch", "-w"].includes(args[i])) watch = args[i + 1] !== "false";
    if (["--watch=true", "-w=true"].includes(args[i])) watch = true;
    if (["--watch=false", "-w=false", "--no-watch"].includes(args[i]))
      watch = false;
  }
  return watch;
}

export function privateLockDir() {
  // Keep the original location so older checkouts' typechecks participate.
  const dir = join(
    process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"),
    "loop-typecheck",
  );
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = statSync(dir);
    return info.isDirectory() &&
      info.uid === userInfo().uid &&
      !(info.mode & 0o077)
      ? dir
      : null;
  } catch {
    return null;
  }
}

export async function withHeavySlot(command, args, options = {}) {
  const {
    label = "heavy check",
    lockFile,
    stdio = "inherit",
    cwd,
    env = process.env,
    signal,
    schedule = true,
    waitSeconds = Number(process.env.LOOP_HEAVY_WAIT_SECONDS ?? 120),
    reserveMiB = Number(process.env.LOOP_HEAVY_RESERVE_MB ?? 2048),
    log = (line) => process.stderr.write(line + "\n"),
  } = options;
  if (signal?.aborted) return 130;
  if (![waitSeconds, reserveMiB].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error(
      "Heavy-check wait and memory reserve must be finite, nonnegative numbers",
    );
  const scheduled =
    schedule &&
    process.platform === "linux" &&
    process.env.LOOP_HEAVY_SCHEDULING !== "off";
  const directory = scheduled && !lockFile ? privateLockDir() : null;
  if (scheduled && !lockFile && !directory) {
    log(`${label}: not started; no private heavy-check lock directory`);
    return SLOT_BUSY_EXIT;
  }
  if (!scheduled)
    log(
      `${label}: running without host admission (${process.platform === "linux" ? "disabled or watch mode" : "Linux only"})`,
    );
  const config = {
    label,
    parentPid: process.pid,
    lock: lockFile ?? (directory && join(directory, "slot.lock")),
    waitSeconds,
    reserveMiB,
  };
  return new Promise((resolve) => {
    const child = spawn(
      scheduled ? "python3" : command,
      scheduled
        ? [
            fileURLToPath(new URL("./heavy-supervisor.py", import.meta.url)),
            JSON.stringify(config),
            command,
            ...args,
          ]
        : args,
      {
        cwd,
        // Preserve only scheduler controls across test environment cleanup.
        // The supervisor verifies the inherited reservation's ancestry.
        env: {
          ...env,
          ...Object.fromEntries(
            [
              "LOOP_HEAVY_SLOT",
              "LOOP_HEAVY_WAIT_SECONDS",
              "LOOP_HEAVY_RESERVE_MB",
              "LOOP_HEAVY_SCHEDULING",
            ]
              .filter((key) => process.env[key] !== undefined)
              .map((key) => [key, process.env[key]]),
          ),
        },
        stdio: scheduled ? [stdio, stdio, stdio, "pipe"] : stdio,
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
    const cleanup = () => {
      for (const [name, handler] of handlers) process.off(name, handler);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      log(
        `${label}: not started: ${error.message}${scheduled ? "; Linux admission requires Python 3.8+" : ""}`,
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
  process.exitCode = await withHeavySlot(process.execPath, args, {
    label: "browser smoke",
  });
}
