// Serialize `tsc --noEmit` across the agents sharing one host. A full check
// peaks near 2 GiB for about six seconds, so several agents starting one at
// once exhaust the agent memory budget while waiting costs each a few seconds.
// The slot is cooperative: it is not a resource limit and never retries.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const SLOT_BUSY_EXIT = 75; // EX_TEMPFAIL: nothing ran; retry later.
const SPAWN_FAILED_EXIT = 127;
const WAIT_SECONDS = 120;
const QUIET_MS = 1000; // Report waiting only after this long without the slot.

function flockAvailable() {
  return spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
}

/** A directory only this user can write, so no other account can plant the
 * lock path. Returns null when none can be verified. */
export function privateLockDir() {
  const base = process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache");
  const dir = join(base, "loop-typecheck");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = statSync(dir);
    if (!info.isDirectory() || info.uid !== userInfo().uid || (info.mode & 0o077) !== 0)
      return null;
    return dir;
  } catch {
    return null;
  }
}

/** Forward termination of the wrapper to its child for the child's lifetime. */
function forwardSignals(child) {
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => [signal, () => child.kill(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

/** Run the command as a direct child in the caller's process group, telling
 * `bind` its pid, or 0 when it could not start. */
function run(command, args, stdio, bind = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio });
    const stop = forwardSignals(child);
    child
      .on("spawn", () => bind(child.pid))
      .on("error", () => { stop(); bind(0); resolve(SPAWN_FAILED_EXIT); })
      .on("close", (code) => { stop(); resolve(code ?? 1); });
  });
}

/** Hold the slot in a child whose life is tied to the compiler's.
 * Resolves to { bind } once the lock is held, { busy: true } when it stayed
 * busy for the whole wait, or { failed: true } when locking itself failed.
 * bind(pid) tells the holder which process the slot belongs to; it releases
 * when that process exits, so a wrapper killed outright keeps the slot for
 * its orphaned compiler, and a wrapper that never binds releases at once.
 * The compiler never inherits the lock itself: TypeScript's launcher replaces
 * itself with a native binary and Node marks inherited descriptors
 * close-on-exec, so a lock carried by the compiler would be dropped there. */
function acquireSlot(lock, waitSeconds) {
  return new Promise((resolve) => {
    const holder = spawn(
      "flock",
      ["-w", String(waitSeconds), "-E", String(SLOT_BUSY_EXIT), lock,
        "sh", "-c", 'printf locked >&3; exec 3>&-; read pid || exit 0; while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done'],
      { stdio: ["pipe", "ignore", "ignore", "pipe"] },
    );
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    holder.stdio[3].once("data", () => settle({
      bind: (pid) => { holder.stdin.end(pid ? `${pid}\n` : ""); },
    }));
    holder.on("error", () => settle({ failed: true }));
    holder.on("close", (code) => settle(code === SLOT_BUSY_EXIT ? { busy: true } : { failed: true }));
  });
}

/** Run `command` with `args` while holding the per-user typecheck slot.
 * Resolves to the command's exit status, or SLOT_BUSY_EXIT when the slot
 * stayed busy for the whole wait, in which case the command never started. */
export async function withTypecheckSlot(command, args, options = {}) {
  const {
    lockFile = null,
    waitSeconds = WAIT_SECONDS,
    stdio = "inherit",
    log = (line) => process.stderr.write(line + "\n"),
  } = options;
  if (process.platform === "win32" || !flockAvailable()) return run(command, args, stdio);
  const lockDir = lockFile ? null : privateLockDir();
  const lock = lockFile ?? (lockDir && join(lockDir, "slot.lock"));
  if (!lock) {
    log("typecheck: no private lock directory; running without the host's typecheck slot");
    return run(command, args, stdio);
  }
  const started = Date.now();
  let reported = false;
  const timer = setTimeout(() => {
    reported = true;
    log(`typecheck: waiting for the host's typecheck slot (up to ${waitSeconds}s)`);
  }, QUIET_MS);
  const slot = await acquireSlot(lock, waitSeconds);
  clearTimeout(timer);
  if (slot.busy) {
    log(`typecheck: not started, the slot stayed busy for ${waitSeconds}s; retry later`);
    return SLOT_BUSY_EXIT;
  }
  if (slot.failed) {
    log("typecheck: could not take the host's typecheck slot; running without it");
    return run(command, args, stdio);
  }
  if (reported) log(`typecheck: slot acquired after ${Math.round((Date.now() - started) / 1000)}s`);
  return run(command, args, stdio, slot.bind);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The package does not export its bin path; walk up from the library entry
  // to the package's own manifest rather than assuming a layout.
  let root = dirname(createRequire(import.meta.url).resolve("typescript"));
  let manifest;
  for (;;) {
    try {
      manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (manifest.name === "typescript") break;
    } catch {}
    if (dirname(root) === root) throw new Error("The typescript package manifest was not found.");
    root = dirname(root);
  }
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsc;
  if (!bin) throw new Error("The typescript package declares no tsc binary.");
  const args = [join(root, bin), "--noEmit", ...process.argv.slice(2)];
  // Watch mode would hold the slot for a whole session; it runs outside it.
  const watch = process.argv.slice(2).some((arg) => arg === "--watch" || arg === "-w");
  process.exitCode = watch
    ? await run(process.execPath, args, "inherit")
    : await withTypecheckSlot(process.execPath, args);
}
