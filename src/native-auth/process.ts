import type { ChildProcess } from "node:child_process";
import { killOwned } from "../processes.js";

export async function stop(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      killOwned(child, "SIGKILL");
      resolve();
    }, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killOwned(child, "SIGTERM");
  });
}
