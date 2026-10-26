// Cleanup also runs when a smoke is interrupted while awaiting a browser action.
const cleanups = new Set();
let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  const code = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
  process.exitCode = code;
  for (const close of [...cleanups].reverse()) {
    try {
      await close();
    } catch (error) {
      console.error("Smoke cleanup:", error.message);
    }
  }
  process.exit(code);
}
const onInt = () => {
  void stop("SIGINT");
};
const onTerm = () => {
  void stop("SIGTERM");
};
const onHup = () => {
  void stop("SIGHUP");
};

export function trackSmokeCleanup(cleanup) {
  let closing;
  const close = () =>
    (closing ??= Promise.resolve()
      .then(cleanup)
      .finally(() => {
        cleanups.delete(close);
        if (!cleanups.size) {
          process.off("SIGINT", onInt);
          process.off("SIGTERM", onTerm);
          process.off("SIGHUP", onHup);
        }
      }));
  if (stopping) throw new Error("Smoke is stopping");
  if (!cleanups.size) {
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);
  }
  cleanups.add(close);
  return close;
}

export async function stopFixtureProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
