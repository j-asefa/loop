export async function until(fn: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("Timed out: " + fn.toString());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Cleanup can race a fixture's normal exit even after a liveness check. */
export function killFixtureProcess(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
