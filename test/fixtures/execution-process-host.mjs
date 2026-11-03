import { join, resolve } from "node:path";
import { WorkspaceHost } from "../../dist/workspace-host.js";
import { recordOwnedProcesses } from "../../dist/processes.js";
const dir = process.env.LOOP_DATA_DIR;
recordOwnedProcesses(join(dir, "children.json"));
const options = {
  harness: "codex",
  executable: resolve("test/harness.mjs"),
  project: join(dir, "project"),
  version: "fixture",
  billing: "existing",
};
const host = new WorkspaceHost(dir, options);
await host.start(options);
process.send({ origin: host.origin, pair: host.pair().url, pid: process.pid });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await host.close();
  process.exit(0);
};
process.on("message", (message) => {
  const reply = (value) => {
    if (process.connected) process.send({ id: message?.id, ...value });
  };
  if (message?.action === "status")
    return reply({ status: host.gateway.workspace.status() });
  if (message?.action === "origin") {
    host.setOrigin(message.origin);
    return reply({ ok: true });
  }
  if (message?.action === "saturate") {
    void import("../../dist/server/execution-client.js").then(
      ({ executionRequest }) => {
        const requests = Array.from({ length: message.count ?? 128 }, () =>
          executionRequest("runtime.status", {}),
        );
        reply({ ok: true });
        void Promise.allSettled(requests).then((results) => {
          if (process.connected) process.send({ settled: results.length });
        });
      },
    );
    return;
  }
  if (message?.action === "runtime-status") {
    void import("../../dist/server/execution-client.js").then(
      ({ executionRequest }) =>
        executionRequest("runtime.status", {}).then(
          (result) => reply({ result }),
          (error) => reply({ status: error.status, outcome: error.outcome }),
        ),
    );
    return;
  }
  if (message?.action === "close-error") {
    void (async () => {
      const { ExecutionProcess } =
        await import("../../dist/server/execution-process.js");
      const close = ExecutionProcess.prototype.close;
      ExecutionProcess.prototype.close = async function () {
        await close.call(this);
        throw new Error("fixture execution cleanup error");
      };
      try {
        await host.close();
        reply({ ok: true });
      } catch (error) {
        reply({ error: error.message });
      } finally {
        ExecutionProcess.prototype.close = close;
      }
    })();
    return;
  }
  void stop();
});
process.on("disconnect", () => void stop());
