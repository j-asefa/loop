import { join, resolve } from "node:path";
import {
  acquireExecutionOwnership,
  type ExecutionOwnership,
} from "./execution-ownership.js";
import {
  recordOwnedProcesses,
  stopAttachedChildren,
  stopOwnedProcessLaunches,
} from "../processes.js";
import { groupAlive, terminateWorkspace } from "../daemon.js";
import {
  ExecutionParentMessage,
  ExecutionChildMessage,
  EXECUTION_REQUEST_BYTES,
  EXECUTION_RESPONSE_BYTES,
} from "../shared/execution-authority.js";
import { boundedExecutionJson } from "./execution-wire.js";

if (
  process.env.LOOP_PROFILE !== "companion" ||
  !process.send ||
  !process.connected
)
  throw new Error(
    "The companion execution worker requires its parent's inherited IPC channel.",
  );
let authority:
  (typeof import("./execution-authority.js"))["executionAuthority"] | undefined;
let ownership: ExecutionOwnership | undefined;
let mail:
  import("./fleet-mail-worker-client.js").FleetMailWorkerClient | undefined;
let stopping = false;
let failed = false;
let closing: Promise<void> | undefined;
let active = 0;
const send = (value: unknown) => {
  const message = ExecutionChildMessage.parse(
    boundedExecutionJson(value, EXECUTION_RESPONSE_BYTES + 1024),
  );
  if (process.connected) process.send!(message, () => {});
};
function exitWorker(code: number): never {
  // The production worker is a detached group leader. End the entire group
  // atomically after cleanup so late attached subprocesses cannot outlive it.
  // Keep the OS ownership lock until process death, including this last step.
  if (ownership && groupAlive(process.pid))
    process.kill(-process.pid, "SIGKILL");
  process.exit(code);
}
function shutdown() {
  return (closing ??= (async () => {
    stopping = true;
    mail?.close();
    stopOwnedProcessLaunches();
    const deadline = setTimeout(() => {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        process.exit(1);
      }
    }, 9000);
    try {
      authority?.quiesce();
      // Capture and stop detached groups while their leaders can still be
      // identified. Adapter disposal alone does not cover orphan descendants.
      if (ownership) {
        const cleanup = await terminateWorkspace(
          ownership.directory,
          undefined,
          1000,
        );
        if (cleanup.unresolved.length || cleanup.survivors.length)
          throw new Error(
            "Native children remain unresolved; their records are retained and takeover is refused.",
          );
      }
      await stopAttachedChildren();
      await authority?.close();
      await stopAttachedChildren();
      clearTimeout(deadline);
      exitWorker(failed ? 1 : 0);
    } catch (error) {
      console.error("Execution worker shutdown:", (error as Error).message);
      // The OS releases the lock on exit. The next holder must resolve the
      // retained children before it can recover any application state.
      exitWorker(1);
    }
  })());
}
const boot = (async () => {
  ownership = await acquireExecutionOwnership(
    resolve(process.env.LOOP_DATA_DIR || "./data"),
  );
  if (stopping || !process.connected) return;
  recordOwnedProcesses(join(ownership.directory, "children.json"));
  // A host started with --fleet forks its worker with it. Scheduled and
  // queued effects delivered here keep their fleet authorization checks.
  // Without it, effects a peer authorized earlier are refused, never run.
  {
    const { registerEffectAuthority } = await import("./effect-authority.js");
    if (process.argv.includes("--fleet")) {
      const { fleetEffectAuthority } =
        await import("./fleet-effect-authorizations.js");
      registerEffectAuthority(fleetEffectAuthority);
    } else {
      const { refuseRecordedEffects } = await import("./recorded-effects.js");
      const { db } = await import("./db.js");
      registerEffectAuthority(refuseRecordedEffects(db));
    }
  }
  authority = (await import("./execution-authority.js")).executionAuthority;
  const { FleetMailWorkerClient } =
    await import("./fleet-mail-worker-client.js");
  const { OWNER } = await import("./native-sessions.js");
  mail = new FleetMailWorkerClient(OWNER, ownership.generation, (request) =>
    send({ type: "fleet-mail-read", request }),
  );
  if (stopping || !process.connected) return;
  await authority.open();
  if (stopping || !process.connected) return;
  send({ type: "ready", ready: authority.status() });
})();
const stop = () => {
  stopping = true;
  void boot.then(shutdown, shutdown);
};
process.once("disconnect", stop);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, stop);
void boot.catch((error) => {
  failed = true;
  console.error("Execution worker startup:", (error as Error).message);
  return shutdown();
});
process.on("message", (raw) => {
  if (stopping || !authority || !ownership) return;
  void (async () => {
    const message = ExecutionParentMessage.parse(
      boundedExecutionJson(raw, EXECUTION_REQUEST_BYTES + 1024),
    );
    if (message.type === "fleet-mail-response") {
      mail!.receive(message.response);
      return;
    }
    if (message.type === "fleet-mail-state") {
      ownership!.assertCurrent(message.state.generation);
      mail!.configure(message.state);
      send({
        type: "ack",
        requestId: message.state.requestId,
        generation: ownership!.generation,
        ok: true,
      });
      return;
    }
    if (message.type === "request") {
      if (active >= 128) {
        send({
          type: "response",
          response: {
            v: 1,
            requestId: message.request.requestId,
            generation: ownership!.generation,
            ok: false,
            error: {
              status: 503,
              message:
                "Execution worker is busy. Retry after pending requests settle.",
              outcome: "refused",
            },
          },
        });
        return;
      }
      active++;
      try {
        send({
          type: "response",
          response: await authority!.request(message.request),
        });
      } finally {
        active--;
      }
      return;
    }
    let ok = false;
    try {
      ownership!.assertCurrent(message.generation);
      if (message.action === "schedule") authority!.schedule();
      else if (message.action === "origin") {
        if (!message.origin) throw new Error("Origin is required.");
        (await import("./config.js")).config.url = message.origin;
      }
      ok = true;
    } catch {
      /* A stale generation cannot change scheduling or live state. */
    }
    send({
      type: "ack",
      requestId: message.requestId,
      generation: ownership!.generation,
      ok,
    });
    if (ok && message.action === "stop") stop();
  })().catch(() => {
    console.error("Execution worker rejected an invalid IPC message.");
    stop();
  });
});
