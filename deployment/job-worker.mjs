// Pueue starts this small worker only when the shared queue admits a job.
// A live, authenticated submitting process must authorize exactly one execution.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { signedMessage, verifiedMessage } from "./job-protocol.mjs";

let socket,
  child,
  escalation,
  cancelled = 0,
  started = false;
function cancel(signal = "SIGTERM") {
  cancelled ||= 128 + (constants.signals[signal] || 15);
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    process.kill(-child.pid, signal);
  } catch {}
  escalation ??= setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 6000);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => cancel(signal));

async function execute(job) {
  if (cancelled || started) return cancelled || 125;
  started = true;
  const supervised = process.platform === "linux";
  const args = supervised
    ? [
        fileURLToPath(
          new URL("../scripts/heavy-supervisor.py", import.meta.url),
        ),
        JSON.stringify({ label: job.label, parentPid: process.pid }),
        job.command,
        ...job.args,
      ]
    : job.args;
  child = spawn(supervised ? "python3" : job.command, args, {
    cwd: job.cwd,
    env: job.env,
    detached: true,
    stdio: supervised
      ? ["ignore", job.stdio, job.stdio, "pipe"]
      : ["ignore", job.stdio, job.stdio],
  });
  child.stdio[3]?.pipe(process.stderr);
  if (cancelled) cancel();
  return new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("close", (code, signal) =>
      resolve(cancelled || (code ?? 128 + (constants.signals[signal] || 1))),
    );
  });
}

async function main() {
  const descriptor = process.argv[2];
  const control = JSON.parse(await readFile(descriptor, "utf8"));
  if (
    !Number.isInteger(control.port) ||
    control.port < 1 ||
    control.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(control.key)
  )
    throw new Error("Invalid job control endpoint.");
  try {
    return await new Promise((resolve, reject) => {
      socket = connect({ host: "127.0.0.1", port: control.port });
      socket.setEncoding("utf8");
      const nonce = randomBytes(32).toString("hex");
      let input = "",
        authorized = false,
        done = false;
      const timer = setTimeout(() => {
        cancel();
        socket.destroy();
        reject(new Error("Job authorization timed out."));
      }, 5000);
      socket.once("connect", () =>
        socket.write(
          JSON.stringify(
            signedMessage(control.key, nonce, "request", { run: true }),
          ) + "\n",
        ),
      );
      socket.on("error", () => {
        if (!authorized)
          reject(
            new Error(
              "Submitting process is unavailable; command was not started.",
            ),
          );
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (!done) cancel();
        if (!authorized) resolve(125);
      });
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (input.length > 8 * 1024 * 1024) {
          cancel();
          socket.destroy();
          return;
        }
        let end;
        while ((end = input.indexOf("\n")) >= 0) {
          let message;
          try {
            message = verifiedMessage(
              control.key,
              nonce,
              "response",
              JSON.parse(input.slice(0, end)),
            );
            if (!message) throw new Error("Unauthenticated job response.");
          } catch {
            cancel();
            socket.destroy();
            return;
          }
          input = input.slice(end + 1);
          if (message.cancel) {
            cancel();
            if (!authorized) socket.end();
            continue;
          }
          if (authorized || !message.execute) continue;
          authorized = true;
          clearTimeout(timer);
          void execute(message.execute).then((code) => {
            done = true;
            socket.end(
              JSON.stringify(
                signedMessage(control.key, nonce, "request", { code }),
              ) + "\n",
            );
            resolve(code);
          }, reject);
        }
      });
    });
  } finally {
    clearTimeout(escalation);
    socket?.destroy();
    // Rendezvous files contain no command, environment or account credentials.
    if (/\/job-[^/]+\/control\.json$/.test(descriptor))
      await rm(dirname(descriptor), { recursive: true, force: true });
  }
}
try {
  process.exitCode = await main();
} catch {
  cancel();
  console.error(
    "Queued command could not complete. Review its saved output before retrying; no command was replayed.",
  );
  process.exitCode = 125;
}
