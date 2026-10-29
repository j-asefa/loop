#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import {
  runQueuedJob,
  queueConfiguration,
  cancelQueuedJob,
  queueStatus,
  taskState,
  insideQueuedJob,
} from "./job-client.mjs";
const [action, ...args] = process.argv.slice(2);
try {
  const config = await queueConfiguration();
  if (action === "run") {
    const command = args[0] === "--" ? args.slice(1) : args;
    if (!command.length)
      throw new Error("Usage: loop-job run -- COMMAND [ARGUMENTS]");
    if (insideQueuedJob(config)) {
      // The outer admitted worker already owns supervision and cleanup. An
      // explicit nested job must finish in that slot, not wait behind itself.
      process.exitCode = await new Promise((resolve) => {
        const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
        const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
          signal,
          () => child.kill(signal),
        ]);
        for (const [signal, handler] of handlers) process.on(signal, handler);
        child.once("error", () => resolve(127));
        child.once("close", (code, signal) => {
          for (const [name, handler] of handlers) process.off(name, handler);
          resolve(code ?? 128 + (constants.signals[signal] || 1));
        });
      });
    } else {
      process.exitCode = await runQueuedJob(command[0], command.slice(1), {
        label: "manual check",
      });
    }
  } else if (action === "status" || !action) {
    const state = await queueStatus(config);
    const tasks = Object.values(state.tasks).filter(
      (t) => t.group === config.group,
    );
    console.log(
      "Heavy checks: " +
        state.groups[config.group]?.status +
        "; parallel jobs: " +
        state.groups[config.group]?.parallel_tasks,
    );
    for (const task of tasks) {
      const label = task.label?.replace(/^loop:[a-f0-9-]+:/, "") || "check";
      const identity = /^loop:([a-f0-9-]{36}):/.exec(task.label || "")?.[1];
      console.log(
        (identity || "external:" + task.id) +
          "\t" +
          taskState(task) +
          "\t" +
          label,
      );
    }
    if (!tasks.length) console.log("No pending heavy checks.");
  } else if (action === "cancel") {
    if (args.length !== 1) throw new Error("Usage: loop-job cancel JOB_ID");
    await cancelQueuedJob(config, args[0]);
    console.log("Cancellation requested for job " + args[0] + ".");
  } else {
    throw new Error(
      "Usage: loop-job status | cancel JOB_ID | run -- COMMAND [ARGUMENTS]",
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 125;
}
