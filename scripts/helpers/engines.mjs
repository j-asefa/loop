import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "@playwright/test";
import { runSupervised } from "../heavy-command.mjs";
import { trackSmokeCleanup } from "./smoke-lifecycle.mjs";

// One rule for every browser smoke: LOOP_BROWSER names a single engine, and
// leaving it unset runs each engine in turn.
const engines = { chromium, webkit };

function selectedName() {
  const selected = process.env.LOOP_BROWSER;
  if (selected && !Object.hasOwn(engines, selected))
    throw new Error(`Unknown LOOP_BROWSER: ${selected}`);
  return selected;
}

/** For smokes that loop over engines within one process. */
export function selectedEngines() {
  const selected = selectedName();
  return selected ? [engines[selected]] : [chromium, webkit];
}

/**
 * For smokes that run one engine per process. With LOOP_BROWSER unset, this
 * reruns the calling script once per engine and exits with the first failure.
 * Call it before the script starts servers or browsers.
 */
export async function engineForRun(scriptUrl) {
  const selected = selectedName();
  if (selected) {
    if (process.connected) {
      // A monitored worker can exit before its asynchronous finally blocks run.
      // Limit this fallback to the worker's own fixture directory.
      const directory = mkdtempSync(join(tmpdir(), "loop-browser-worker-"));
      const removeDirectory = () => {
        process.off("exit", removeDirectory);
        try {
          rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
        } catch (error) {
          console.error("Browser fixture cleanup:", error.message);
        }
      };
      trackSmokeCleanup(removeDirectory);
      process.once("exit", removeDirectory);
      process.env.TMPDIR = process.env.TEMP = process.env.TMP = directory;
    }
    return selected;
  }
  // The supervisor forwards signals to its child. Remember them here too,
  // in case the child has already exited successfully when a signal arrives.
  let interrupted = 0;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, () => {
      interrupted ||= 128 + constants.signals[signal];
    });
  for (const name of Object.keys(engines)) {
    const status = await runSupervised(
      process.execPath,
      [...process.execArgv, fileURLToPath(scriptUrl), ...process.argv.slice(2)],
      {
        label: `${name} browser smoke`,
        exitWithParent: true,
        env: { ...process.env, LOOP_BROWSER: name },
      },
    );
    if (interrupted || status !== 0) process.exit(interrupted || status);
  }
  process.exit(0);
}

export function browserType(name) {
  return engines[name];
}

export function chromiumExecutable(engine) {
  return engine === chromium
    ? process.env.CHROMIUM_PATH || undefined
    : undefined;
}
