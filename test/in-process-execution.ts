import type { ExecutionLifecycle } from "../src/server/execution-process.js";

/** Authority contract fixtures inject faults into live objects deliberately.
 * Default WorkspaceHost, compiled CLI, browser and crash fixtures use IPC. */
export const inProcessExecution: ExecutionLifecycle = {
  async open() { await (await import("../src/server/execution-client.js")).openExecution(); },
  async schedule() { await (await import("../src/server/execution-client.js")).scheduleExecution(); },
  async close() { await (await import("../src/server/execution-client.js")).closeExecution(); },
};
