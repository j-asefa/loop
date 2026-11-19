import type { ChildProcess } from "node:child_process";

export function trackSmokeCleanup(
  cleanup: () => void | Promise<void>,
): () => Promise<void>;

export function stopFixtureProcess(child: ChildProcess): Promise<void>;
