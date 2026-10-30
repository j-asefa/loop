// Fault injection surrounds the real fork and inherited IPC without importing
// application state before the production worker has acquired ownership.
import { existsSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const dir = process.env.LOOP55_TEST_SUPERVISION;
if (dir && !process.argv[1]?.endsWith("/execution-worker.js")) {
  const fork = childProcess.fork;
  childProcess.fork = function (...args) {
    const fail = join(dir, "fail-fork");
    if (String(args[0]).endsWith("/execution-worker.js") && existsSync(fail)) {
      unlinkSync(fail);
      writeFileSync(join(dir, "fork-failed"), "EAGAIN");
      const child = new childProcess.ChildProcess();
      queueMicrotask(() =>
        child.emit(
          "error",
          Object.assign(new Error("fixture fork EAGAIN"), { code: "EAGAIN" }),
        ),
      );
      return child; // A failed spawn emits error without exit.
    }
    return fork.apply(this, args);
  };
  syncBuiltinESMExports();
}
if (dir && process.argv[1]?.endsWith("/execution-worker.js")) {
  const on = process.on;
  let held = 0;
  process.on = function (event, callback) {
    if (event !== "message") return on.call(this, event, callback);
    return on.call(this, event, (message) => {
      const later = (path, done) => {
        const deadline = Date.now() + 20_000;
        const timer = setInterval(() => {
          if (existsSync(path) && Date.now() < deadline) return;
          clearInterval(timer);
          done();
        }, 10);
      };
      if (
        message.type === "lifecycle" &&
        message.action === "schedule" &&
        existsSync(join(dir, "fail-schedule"))
      ) {
        unlinkSync(join(dir, "fail-schedule"));
        writeFileSync(join(dir, "schedule-held"), String(process.pid));
        later(join(dir, "hold-schedule"), () => {
          if (process.connected)
            process.send({
              type: "ack",
              requestId: message.requestId,
              generation: message.generation,
              ok: false,
            });
        });
        return;
      }
      if (message.type === "lifecycle" && message.action === "origin") {
        appendFileSync(join(dir, "origins"), message.origin + "\n");
        if (existsSync(join(dir, "hold-origin"))) {
          writeFileSync(join(dir, "origin-held"), "1");
          later(join(dir, "hold-origin"), () => callback(message));
          return;
        }
      }
      if (
        message.type === "request" &&
        message.request.method === "runtime.status" &&
        existsSync(join(dir, "hold-requests"))
      ) {
        writeFileSync(join(dir, "held-requests"), String(++held));
        later(join(dir, "hold-requests"), () => callback(message));
        return;
      }
      callback(message);
    });
  };
}
