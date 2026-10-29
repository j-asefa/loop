// Pueue owns ordering and process state. Commands and credentials travel over a
// private, live control connection, never in Pueue's persisted environment.
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { constants, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { signedMessage, verifiedMessage } from "./job-protocol.mjs";
import { peerIsSameUser } from "./job-peer.mjs";

const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export async function queueConfiguration(
  path = process.env.LOOP_JOB_QUEUE_CONFIG ||
    join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "loop",
      "jobs.json",
    ),
) {
  if (!path || !isAbsolute(path))
    throw new Error("An absolute job queue configuration path is required.");
  const config = JSON.parse(await readFile(path, "utf8"));
  for (const key of ["pueue", "config", "jobs"])
    if (typeof config[key] !== "string" || !isAbsolute(config[key]))
      throw new Error("Invalid job queue configuration: " + key);
  for (const key of ["worker", "shims"])
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "string" || !isAbsolute(config[key]))
    )
      throw new Error("Invalid job queue configuration: " + key);
  if (!/^[a-zA-Z0-9_-]+$/.test(config.group))
    throw new Error("Invalid job queue group.");
  return config;
}

export function insideQueuedJob(config) {
  if (process.env.LOOP_JOB_ACTIVE) return true;
  // Test fixtures intentionally clear LOOP_* settings. Ownership survives that
  // sanitization: otherwise an inner check could wait behind its own parent.
  if (process.platform === "linux") {
    try {
      if (
        readFileSync("/proc/self/cgroup", "utf8").includes(
          "/loop-agents-jobs.slice/",
        )
      )
        return true;
    } catch {}
  }
  const workers = [
    config.worker,
    fileURLToPath(new URL("./job-worker.mjs", import.meta.url)),
  ].filter(Boolean);
  const descriptorSuffix = new RegExp(
    " /?.*/job-worker\\.mjs " +
      config.jobs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "/job-[a-f0-9-]{36}/control\\.json$",
  );
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 48; depth++) {
    try {
      const row = execFileSync(
        "ps",
        ["-p", String(pid), "-o", "ppid=", "-o", "args="],
        {
          encoding: "utf8",
          timeout: 1000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      const match = /^(\d+)\s+([\s\S]+)$/.exec(row);
      if (!match) return false;
      if (
        [process.execPath, config.commands?.node]
          .filter(Boolean)
          .some(
            (node) =>
              workers.some((worker) =>
                match[2].startsWith(node + " " + worker + " "),
              ) ||
              (match[2].startsWith(node + " ") &&
                descriptorSuffix.test(match[2])),
          )
      )
        return true;
      const parent = Number(match[1]);
      if (parent === pid) return false;
      pid = parent;
    } catch {
      return false;
    }
  }
  return false;
}

function clientEnvironment() {
  // The daemon must not save the submitting harness's credential environment.
  return Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "TMPDIR"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
}

export async function queueCommand(config, args) {
  const result = await exec(
    config.pueue,
    ["--config", config.config, ...args],
    {
      env: clientEnvironment(),
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return result.stdout;
}

export async function queueStatus(config) {
  return JSON.parse(await queueCommand(config, ["status", "--json"]));
}

export function taskState(task) {
  return typeof task.status === "string"
    ? task.status
    : Object.keys(task.status)[0];
}

export async function cancelQueuedJob(config, identity) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      identity,
    )
  )
    throw new Error("Use the job ID printed by loop-job status.");
  let control;
  try {
    control = JSON.parse(
      await readFile(
        join(config.jobs, "job-" + identity, "control.json"),
        "utf8",
      ),
    );
  } catch {
    throw new Error("That job is no longer waiting or running.");
  }
  // Pueue may reuse numeric task IDs after cleanup. Address the original live
  // caller instead, so a delayed cancel can never target a newer command.
  const legacy = control.protocol === undefined;
  if (!legacy && control.protocol !== 2)
    throw new Error("Unsupported job control protocol.");
  const key = legacy ? control.key : control.secret;
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid job control key.");
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: control.port });
    socket.setEncoding("utf8");
    if (legacy) socket.pause();
    const nonce = randomBytes(32).toString("hex");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Job cancellation was not acknowledged."));
    }, 5000);
    let input = "",
      acknowledged = false;
    socket.on("connect", async () => {
      if (legacy && !(await peerIsSameUser(socket))) return socket.destroy();
      socket.write(
        JSON.stringify(
          legacy
            ? { key, cancel: true }
            : signedMessage(key, nonce, "request", { cancel: true }),
        ) + "\n",
      );
      if (legacy) socket.resume();
    });
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 1024) return socket.destroy();
      if (input.includes("\n")) {
        try {
          const response = JSON.parse(input.trim());
          acknowledged =
            (legacy
              ? response
              : verifiedMessage(key, nonce, "response", response)
            )?.cancelled === true;
        } catch {}
        socket.end();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      if (acknowledged) resolve();
      else
        reject(
          new Error(
            "The job's caller is unavailable; no other job was cancelled.",
          ),
        );
    });
  });
}

function resultCode(task) {
  const result = task.status?.Done?.result;
  if (result === "Success") return 0;
  if (Number.isInteger(result?.Failed)) return result.Failed;
  return 125; // Killed, lost, or dependency failure: never resubmit implicitly.
}

export async function runQueuedJob(command, args, options = {}) {
  const {
    label = "check",
    env = process.env,
    cwd = process.cwd(),
    stdio = "inherit",
    signal,
    log = (line) => process.stderr.write(line + "\n"),
  } = options;
  if (signal?.aborted) return 130;
  const config = await queueConfiguration();
  const initial = await queueStatus(config);
  if (!initial.groups?.[config.group])
    throw new Error("The configured job queue group is missing.");
  // A killed caller cannot remove its finished task. Retain orphaned logs for
  // a day, then prune only Loop-owned completed jobs on the next submission.
  for (const task of Object.values(initial.tasks || {})) {
    const orphan = /^loop:([a-f0-9-]{36}):/.exec(task.label || "");
    if (
      task.group === config.group &&
      orphan &&
      taskState(task) === "Done" &&
      Date.parse(task.status.Done.end) < Date.now() - 86400000
    ) {
      try {
        const descriptor = join(
          config.jobs,
          "job-" + orphan[1],
          "control.json",
        );
        try {
          const control = JSON.parse(await readFile(descriptor, "utf8"));
          if (Number.isInteger(control.pid) && control.pid > 1) {
            try {
              process.kill(control.pid, 0);
              continue; // A completed command may still be draining output.
            } catch (error) {
              if (error.code !== "ESRCH") continue;
            }
          }
        } catch (error) {
          if (error.code !== "ENOENT") continue;
        }
        await queueCommand(config, ["remove", String(task.id)]);
        await rm(join(config.jobs, "job-" + orphan[1]), {
          recursive: true,
          force: true,
        });
      } catch {}
    }
  }
  const name = String(label)
    .replace(/[\r\n\x00-\x1f]/g, " ")
    .slice(0, 100);
  const identity = randomUUID();
  const taskLabel = "loop:" + identity + ":" + name;
  const key = randomBytes(32).toString("hex");
  const cancellationKey = randomBytes(32).toString("hex");
  let directory,
    taskId,
    follower,
    following,
    admitted = false,
    completed = false;
  let cancelled = 0,
    cancelAt = 0,
    outcome,
    actualResult,
    connection,
    connectionNonce,
    followerEscalation,
    lastReport = "";
  let lastReportAt = 0;
  const stopFollower = () => {
    follower?.kill("SIGTERM");
    followerEscalation ??= setTimeout(() => follower?.kill("SIGKILL"), 1500);
    followerEscalation.unref();
  };
  const cancel = (code = 130) => {
    if (cancelled) return;
    cancelled = code;
    cancelAt = Date.now();
    if (connection)
      connection.write(
        JSON.stringify(
          signedMessage(key, connectionNonce, "response", { cancel: true }),
        ) + "\n",
      );
    if (completed) stopFollower();
  };
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "",
      nonce,
      authenticated = false;
    socket.on("error", () => {});
    socket.setTimeout(5000, () => {
      if (!authenticated) socket.destroy();
    });
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 4096) return socket.destroy();
      let end;
      while ((end = input.indexOf("\n")) >= 0) {
        let message;
        try {
          const envelope = JSON.parse(input.slice(0, end));
          // Old operator CLIs send a bearer key. Give them cancellation-only
          // authority, never the signing key that authorizes worker execution.
          if (
            !authenticated &&
            envelope?.cancel === true &&
            typeof envelope.key === "string" &&
            envelope.key.length === cancellationKey.length &&
            timingSafeEqual(
              Buffer.from(envelope.key),
              Buffer.from(cancellationKey),
            )
          ) {
            cancel(143);
            return socket.end('{"cancelled":true}\n');
          }
          nonce ??= envelope?.nonce;
          message = verifiedMessage(key, nonce, "request", envelope);
          if (!message) return socket.destroy();
        } catch {
          return socket.destroy();
        }
        input = input.slice(end + 1);
        if (!authenticated) {
          authenticated = true;
          socket.setTimeout(0);
          if (message.cancel === true) {
            cancel(143);
            return socket.end(
              JSON.stringify(
                signedMessage(key, nonce, "response", { cancelled: true }),
              ) + "\n",
            );
          }
          if (message.run !== true) return socket.destroy();
          // A manually restarted Pueue task cannot replay an already dispatched command.
          if (admitted || cancelled)
            return socket.end(
              JSON.stringify(
                signedMessage(key, nonce, "response", { cancel: true }),
              ) + "\n",
            );
          admitted = true;
          connection = socket;
          connectionNonce = nonce;
          socket.write(
            JSON.stringify(
              signedMessage(key, nonce, "response", {
                execute: {
                  command,
                  args,
                  cwd,
                  env: { ...env, LOOP_JOB_ACTIVE: identity },
                  stdio,
                  label: name,
                },
              }),
            ) + "\n",
          );
        } else if (
          Number.isInteger(message.code) &&
          message.code >= 0 &&
          message.code <= 255
        ) {
          actualResult = message.code;
        }
      }
    });
  });
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((name) => [
    name,
    () => cancel(128 + constants.signals[name]),
  ]);
  const abort = () => cancel();
  try {
    await mkdir(config.jobs, { recursive: true, mode: 0o700 });
    directory = join(config.jobs, "job-" + identity);
    await mkdir(directory, { mode: 0o700 });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const descriptor = join(directory, "control.json");
    await writeFile(
      descriptor,
      JSON.stringify({
        port: server.address().port,
        // An old CLI can cancel, but cannot disclose the execution credential.
        key: cancellationKey,
        secret: key,
        pid: process.pid,
        protocol: 2,
      }),
      { mode: 0o600 },
    );
    for (const [name, handler] of handlers) process.on(name, handler);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) cancel();
    if (cancelled) return cancelled;
    // A source checkout and an installed shim may use different protocol
    // generations. Always launch the worker shipped alongside this client.
    const worker = fileURLToPath(new URL("./job-worker.mjs", import.meta.url));
    // The queue sees only a worker and a private rendezvous file, never user argv.
    const line =
      "exec " +
      [process.execPath, worker, descriptor, config.worker || worker]
        .map(quote)
        .join(" ");
    taskId = (
      await queueCommand(config, [
        "add",
        "--print-task-id",
        "--group",
        config.group,
        "--label",
        taskLabel,
        "--working-directory",
        cwd,
        "--",
        line,
      ])
    ).trim();
    if (!/^\d+$/.test(taskId))
      throw new Error(
        "The queue did not return a task ID; execution was not resubmitted.",
      );
    log(
      "Queued job " +
        identity +
        ": " +
        name +
        ". Inspect with loop-job status; cancel with loop-job cancel " +
        identity +
        ".",
    );
    follower = spawn(
      config.pueue,
      ["--config", config.config, "follow", taskId],
      {
        env: clientEnvironment(),
        stdio: ["ignore", stdio, "ignore"],
      },
    );
    following = new Promise((resolve) => {
      follower.once("close", (code) => resolve(code === 0));
      follower.once("error", () => resolve(false));
    });
    for (;;) {
      const state = await queueStatus(config);
      const task = state.tasks?.[taskId];
      if (!task || task.label !== taskLabel)
        throw new Error(
          "The job disappeared from the queue. Review saved output before retrying.",
        );
      const status = taskState(task);
      if (status === "Done") {
        completed = true;
        outcome = actualResult ?? resultCode(task);
        break;
      }
      if (cancelled) {
        if (status !== "Running" && status !== "Paused") {
          // If it starts during this request, the live handshake still refuses execution.
          try {
            await queueCommand(config, ["remove", taskId]);
            completed = true;
            return cancelled;
          } catch {
            /* the worker may be starting; keep cancellation active */
          }
        }
        if (!connection || Date.now() - cancelAt > 8000) {
          await queueCommand(config, ["kill", taskId]).catch(() => {});
        }
        if (Date.now() - cancelAt > 12000) return cancelled;
      }
      const peers = Object.values(state.tasks).filter(
        (t) => t.group === config.group && taskState(t) !== "Done",
      );
      const running = peers.filter((t) => taskState(t) === "Running").length;
      const paused = state.groups[config.group].status !== "Running";
      const report =
        status === "Running"
          ? "Running job " + identity + ": " + name
          : "Queued job " +
            identity +
            ": " +
            running +
            " running, " +
            (peers.length - running) +
            " waiting" +
            (paused ? "; queue is paused" : "");
      if (report !== lastReport || Date.now() - lastReportAt >= 30000) {
        log(report);
        lastReport = report;
        lastReportAt = Date.now();
      }
      await delay(500);
    }
  } finally {
    // Closing this live connection also stops an orphaned running worker.
    connection?.destroy();
    let outputDelivered = false;
    if (follower) {
      // Normal pipe backpressure must not truncate a completed job's output.
      // Keep cancellation handlers until the follower has drained or stopped.
      if (!completed || cancelled) stopFollower();
      outputDelivered = await following;
      clearTimeout(followerEscalation);
      if (completed && !outputDelivered)
        log(
          "Job output was not fully delivered; its queue logs were retained for inspection.",
        );
    }
    server.close();
    for (const [name, handler] of handlers) process.off(name, handler);
    signal?.removeEventListener("abort", abort);
    if (directory) await rm(directory, { recursive: true, force: true });
    // Completed output already reached Loop's command trace. Remove only this
    // invocation's task so persisted queue logs cannot grow without a bound.
    if (completed && taskId && outputDelivered) {
      try {
        const state = await queueStatus(config);
        const task = state.tasks?.[taskId];
        if (task?.label === taskLabel && taskState(task) === "Done")
          await queueCommand(config, ["remove", taskId]);
      } catch {
        /* diagnostic cleanup must not replace the command's result */
      }
    }
  }
  return cancelled || outcome;
}
