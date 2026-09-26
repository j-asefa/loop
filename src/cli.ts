#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpath, readFile, open } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import qr from "qrcode-terminal";
import { Harness } from "./protocol.js";
import { privateDir, atomic } from "./state.js";
import { Tunnel, TunnelSupervisor } from "./tunnel.js";
import type { Options } from "./adapters/types.js";
import { discover, control } from "./host-control.js";
import {
  installDaemonLog,
  retireLog,
  exited,
  recordedWorkspace,
  forgetWorkspace,
  terminateWorkspace,
  recordedChildren,
  keepUnresolved,
  type Recorded,
} from "./daemon.js";
import { recordOwnedProcesses } from "./processes.js";
const { version: VERSION } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const names = Harness.options;
// Covers a first-run cloudflared download (120s) plus tunnel startup (45s).
const STARTUP_TIMEOUT_MS = 240000;
const STOP_WAIT_MS = 20000;
// How long a workspace that stopped answering gets to exit after SIGTERM.
const STOP_GRACE_MS = 5000;
const LOG_POLL_MS = 500;
// Set only on the detached workspace process spawned by `loop <harness>`.
const daemonChild =
  process.env.LOOP_DAEMON_CHILD === "1" && typeof process.send === "function";
type Pair = { url: string; expiresIn: number };
type Ready = {
  ready: true;
  description: string;
  notice?: string;
  pair: Pair;
};
function showPair(pair: Pair) {
  console.log(
    "\nScan with your phone to pair a new device, or with the Loop app to reconnect it after a restart. This single-use code expires in 2 minutes.",
  );
  qr.generate(pair.url, { small: true });
  console.log(pair.url);
  console.log("Anyone holding this link can control this workspace.\n");
}
function showReady(ready: Ready, withCode = true) {
  console.log("Loop workspace ready. " + ready.description);
  console.log(
    "Create agents in Loop; multiple agents may use the same project. Commands: loop status, loop pair, loop logs, loop stop.",
  );
  if (ready.notice) console.log(ready.notice);
  if (withCode) showPair(ready.pair);
  else console.log("Run loop pair to show a pairing code.");
}
function report(message: Ready | { error: string }) {
  if (!daemonChild || !process.connected) return;
  process.send!(message, () => {
    if (process.connected) process.disconnect?.();
  });
}
// No terminal owns the background workspace, so `loop stop` escalates itself.
// With no workspace (it crashed), this still stops its recorded native processes.
export async function forceStop(
  dir: string,
  workspace: Recorded | undefined,
  reason: string,
  kill?: (pid: number, signal: NodeJS.Signals) => void,
) {
  if (workspace)
    console.error(
      `Workspace process ${workspace.pid} ${reason}; terminating it and its native processes.`,
    );
  const { unresolved, survivors } = await terminateWorkspace(
    dir,
    workspace,
    STOP_GRACE_MS,
    kill,
  );
  if (survivors.length)
    throw new Error(
      `Process(es) ${survivors.join(", ")} did not exit. The workspace record was kept; check them with ps.`,
    );
  if (unresolved.length) {
    await keepUnresolved(dir, unresolved);
    throw new Error(
      `${unresolved.length} recorded native process(es) (${unresolved.map((r) => r.pid).join(", ")}) could not be confirmed as Loop's, or led a process group that outlived them, so they were left running. They stay on record: check them with ps, then run loop stop again.`,
    );
  }
  await forgetWorkspace(dir);
}
async function stopWorkspace(dir: string) {
  const recorded = await recordedWorkspace(dir);
  const answered = await control(dir, "stop").then(
    () => true,
    () => false,
  );
  if (!answered) {
    if (!recorded) {
      // A previous stop may have left records it couldn't resolve.
      if ((await recordedChildren(dir)).length)
        return forceStop(dir, undefined, "exited");
      throw new Error("No workspace is running.");
    }
    if (recorded.state === "unknown")
      throw new Error(
        `Workspace process ${recorded.pid} is not responding, and Loop can't confirm that PID still belongs to the workspace, so nothing was stopped. Check it (for example with ps) and stop it yourself.`,
      );
    if (recorded.state === "running")
      return forceStop(dir, recorded, "is not responding");
    return forceStop(dir, undefined, "exited");
  }
  if (
    recorded?.state === "running" &&
    !(await exited(recorded.pid, STOP_WAIT_MS))
  )
    return forceStop(
      dir,
      recorded,
      `did not exit within ${STOP_WAIT_MS / 1000}s`,
    );
  // Retry anything an earlier incomplete stop left on record.
  if ((await recordedChildren(dir)).length)
    return forceStop(dir, undefined, "exited");
}
async function daemonize(dir: string, args: string[]) {
  const log = join(dir, "daemon.log");
  await retireLog(log);
  const fd = openSync(log, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), ...args],
      {
        detached: true,
        stdio: ["ignore", fd, fd, "ipc"],
        env: { ...process.env, LOOP_DAEMON_CHILD: "1" },
      },
    );
  } finally {
    closeSync(fd);
  }
  const abort = () => child.kill("SIGTERM");
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const ready = await new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Workspace startup timed out. See loop logs."));
      }, STARTUP_TIMEOUT_MS);
      child.once("message", (m: any) => {
        clearTimeout(timer);
        if (m?.ready) resolve(m);
        else reject(new Error(m?.error || "Workspace failed to start."));
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Workspace exited during startup${code ? ` (code ${code})` : ""}. See loop logs.`,
          ),
        );
      });
    });
    showReady(ready);
    console.log(
      "Loop keeps running in the background; you can close this terminal. Logs: loop logs",
    );
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    child.removeAllListeners();
    if (child.connected) child.disconnect();
    child.unref();
  }
}
async function logs(dir: string, follow: boolean) {
  const path = join(dir, "daemon.log");
  let handle = await open(path, "r").catch(() => undefined);
  if (!handle) {
    console.log("No workspace logs yet at " + path);
    return;
  }
  let offset = 0,
    busy = false;
  const drain = async () => {
    if (busy || !handle) return;
    busy = true;
    try {
      const copy = async () => {
        const { size } = await handle!.stat();
        if (size < offset) offset = 0;
        while (offset < size) {
          const { bytesRead, buffer } = await handle!.read(
            Buffer.alloc(Math.min(65536, size - offset)),
            0,
            Math.min(65536, size - offset),
            offset,
          );
          if (!bytesRead) break;
          process.stdout.write(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
      };
      const current = await open(path, "r").catch(() => undefined);
      if (current) {
        // The log rotated: finish the old file's tail, then follow the new one.
        if ((await current.stat()).ino !== (await handle.stat()).ino) {
          await copy();
          await handle.close();
          handle = current;
          offset = 0;
        } else await current.close();
      }
      await copy();
    } finally {
      busy = false;
    }
  };
  await drain();
  if (!follow) {
    await handle.close();
    return;
  }
  const timer = setInterval(() => void drain(), LOG_POLL_MS);
  await new Promise<void>((r) => {
    process.once("SIGINT", r);
    process.once("SIGTERM", r);
  });
  clearInterval(timer);
  await handle.close();
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      project: { type: "string" },
      executable: { type: "string" },
      billing: { type: "string" },
      resume: { type: "string" },
      json: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      foreground: { type: "boolean" },
      "local-only": { type: "boolean" },
      "public-url": { type: "string" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help) {
    console.log(`Loop ${VERSION} — one workspace for your native agents

loop                    Start the full Loop server in the foreground
                        (alias: loop server).
loop codex|claude|pi|opencode [--project PATH] [--executable PATH]
     [--billing subscription|existing] [--resume NATIVE_SESSION]
     [--local-only | --public-url https://stable-origin] [--foreground]
                        Start this computer's workspace with that harness,
                        show a pairing code, then keep running in the
                        background. If the workspace is already running, the
                        harness is added to it; no new pairing is required.
loop pair               Show a fresh pairing code. Scan it to pair a new
                        device, or scan it from the Loop app to reconnect
                        after the tunnel address changed.
loop status [--json] | devices | devices revoke ID | doctor [--json]
loop logs [--follow] | stop | uninstall

Every project and enabled harness shares one workspace host and tunnel.
Phone disconnection does not stop native work; loop stop does.
Default billing is verified native subscription; existing mode retains your
selected native configuration and can incur API charges. No API fallback.
Native permissions, skills, plugins and project configuration are preserved.
Quick Tunnel URLs rotate. When that happens, run loop pair and scan the code
from the Loop app. Cloudflare terminates TLS. macOS/Linux, Node >=22.19.
--foreground keeps the workspace attached to this terminal (for service
managers and debugging).
--resume is an explicit desktop handoff of a native session you have stopped
elsewhere. The UI does not take over arbitrary live Desktop/TUI sessions.
Uninstall removes the package separately; workspace/native history is retained.`);
    return;
  }
  if (!positionals.length || positionals[0] === "server") {
    const companion = (
      [
        "project",
        "executable",
        "billing",
        "resume",
        "local-only",
        "public-url",
        "foreground",
      ] as const
    ).find((k) => values[k] !== undefined);
    if (companion)
      throw new Error(
        `--${companion} applies to loop codex|claude|pi|opencode. Plain loop starts the full server.`,
      );
    if (positionals.length > 1)
      throw new Error("Unknown command. See loop --help.");
    process.env.LOOP_PROFILE = "server";
    const { startServer } = await import("./server/serve.js");
    const { startWorker } = await import("./server/worker.js");
    const server = startServer();
    const stopWorker = startWorker();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await stopWorker();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    return;
  }
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("This release supports macOS and Linux.");
  const root = resolve(
    process.env.LOOP_HOME ?? join(homedir(), ".local", "state", "loop"),
  );
  const dir = join(root, "workspace");
  privateDir(dir);
  const logPath = join(dir, "daemon.log");
  if (daemonChild) installDaemonLog(logPath);
  const project = await realpath(resolve(values.project ?? process.cwd()));
  const action = positionals[0] === "claude-code" ? "claude" : positionals[0];
  if (action === "doctor") {
    const harnesses = await Promise.all(
      names.map((n) => discover(n, values.executable)),
    );
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          stateRoot: root,
          logs: logPath,
          harnesses,
          workspace: await control(dir, "status").catch(() => ({
            state: "stopped",
          })),
          checks: [
            "No model request made.",
            "Native billing is checked when enabling and starting sessions.",
            "Quick Tunnel needs outbound Cloudflare connectivity.",
          ],
        },
        null,
        values.json ? 0 : 2,
      ),
    );
    return;
  }
  if (action === "logs") return logs(dir, !!values.follow);
  if (["pair", "status", "devices", "stop", "uninstall"].includes(action)) {
    if (action === "uninstall") {
      if (await control(dir, "status").catch(() => undefined))
        throw new Error("Run loop stop first.");
      console.log(
        "Workspace and native history retained at " +
          root +
          ". Remove the executable with npm uninstall -g loop. Back up this directory before manually removing workspace data.",
      );
      return;
    }
    if (action === "stop") {
      await stopWorkspace(dir);
      console.log(JSON.stringify({ stopped: true }, null, values.json ? 0 : 2));
      return;
    }
    const output = await control(
      dir,
      action === "devices" && positionals[1] === "revoke" ? "revoke" : action,
      { id: positionals[2] },
    ).catch(async () => {
      if (action === "status") {
        const recorded = await recordedWorkspace(dir);
        const [state, message] = !recorded
          ? [
              "stopped",
              "Run loop codex (or another enabled harness) to open this workspace.",
            ]
          : recorded.state === "exited"
            ? [
                "crashed",
                "The workspace exited unexpectedly. Check loop logs, then run loop codex (or another harness) again.",
              ]
            : recorded.state === "running"
              ? [
                  "unresponsive",
                  "The workspace process is running but not responding. Run loop stop to terminate it.",
                ]
              : [
                  "unknown",
                  "A process has the workspace's recorded PID, but Loop can't confirm it is the workspace.",
                ];
        return {
          workspace: true,
          state,
          stateRoot: root,
          logs: logPath,
          message,
        };
      }
      throw new Error("No responsive workspace host. Run loop codex first.");
    });
    if (action === "pair") showPair(output);
    else console.log(JSON.stringify(output, null, values.json ? 0 : 2));
    return;
  }
  if (positionals.length > 1 || !names.includes(action as Harness))
    throw new Error("Unknown command. See loop --help.");
  if (values["local-only"] && values["public-url"])
    throw new Error("Choose --local-only or --public-url.");
  const selected = action as Harness;
  const running = await control(dir, "status").catch(() => undefined);
  const preferencesPath = join(dir, "preferences.json");
  const preferences = await readFile(preferencesPath, "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  const probe = await discover(selected, values.executable);
  if (!probe.installed || !probe.supported || !probe.version)
    throw new Error(probe.help);
  let billing =
    values.billing ?? preferences.billing?.[selected] ?? "subscription";
  if (!["subscription", "existing"].includes(billing))
    throw new Error("Billing must be subscription or existing.");
  if (
    selected === "opencode" &&
    billing === "subscription" &&
    !values.billing &&
    process.stdin.isTTY
  ) {
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      console.log(
        "OpenCode cannot prove effective subscription billing through its server.",
      );
      if (
        !/^y(es)?$/i.test(
          (
            await input.question(
              "Keep the existing OpenCode provider, which may use API credits? [y/N] ",
            )
          ).trim(),
        )
      )
        throw new Error("No billing mode selected.");
      billing = "existing";
    } finally {
      input.close();
    }
  }
  const options: Options = {
    harness: selected,
    executable: probe.executable,
    version: probe.version,
    project,
    billing,
  };
  const remember = () =>
    atomic(preferencesPath, {
      billing: { ...preferences.billing, [selected]: billing },
    });
  if (running) {
    if (values.resume)
      throw new Error(
        "Open native history in Loop, or stop the host before an explicit --resume handoff.",
      );
    const enabled = await control(dir, "enable", options);
    remember();
    console.log(
      "Enabled " +
        selected +
        " in your existing workspace. " +
        enabled.billing.description,
    );
    console.log(
      "Your paired phone can create agents immediately; no new pairing is required.",
    );
    return;
  }
  if (!values.foreground && !daemonChild)
    return daemonize(dir, [
      selected,
      "--project",
      project,
      "--executable",
      probe.executable,
      "--billing",
      billing,
      ...(values.resume ? ["--resume", values.resume] : []),
      ...(values["local-only"] ? ["--local-only"] : []),
      ...(values["public-url"] ? ["--public-url", values["public-url"]] : []),
    ]);
  const { workspaceLock } = await import("./lifecycle.js");
  const release = workspaceLock(dir);
  recordOwnedProcesses(join(dir, "children.json"));
  let host: import("./workspace-host.js").WorkspaceHost | undefined;
  let tunnel: TunnelSupervisor | undefined,
    stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await tunnel?.stop();
      await host?.close();
    } finally {
      release();
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void stop();
    });
  try {
    process.env.LOOP_DATA_DIR = dir;
    process.env.LOOP_PROFILE = "companion";
    const { WorkspaceHost } = await import("./workspace-host.js");
    if (stopping) return;
    host = new WorkspaceHost(dir, options);
    host.gateway.onStop = stop;
    const { migrateLegacy, resumeFromDesktop } =
      await import("./server/migration.js");
    const enabled = await host.start(options, async () => {
      await migrateLegacy(root);
      if (!stopping && values.resume) resumeFromDesktop(options, values.resume);
    });
    if (stopping) {
      await host.close();
      return;
    }
    remember();
    if (stopping) return;
    // Single-use pairing codes are shown on a terminal or sent over IPC, never
    // written to a log file or a service manager's journal.
    const interactive = !!process.stdout.isTTY;
    const gateway = host;
    let notice: string | undefined;
    if (values["public-url"]) {
      host.setOrigin(values["public-url"]);
      notice = "Point the HTTPS tunnel to http://127.0.0.1:" + host.port;
    } else if (values["local-only"])
      notice = "Local-only: open this link on the desktop.";
    else {
      console.log("Preparing verified cloudflared Quick Tunnel…");
      tunnel = new TunnelSupervisor(
        (exited) => new Tunnel(root, gateway.port, exited),
        (origin, reconnected) => {
          gateway.setOrigin(origin);
          if (!reconnected) return;
          console.log(
            "Quick Tunnel address changed to " +
              origin +
              ". Run loop pair and scan the code from the Loop app to reconnect.",
          );
          if (interactive) showPair(gateway.pair());
        },
      );
      await tunnel.start();
    }
    if (stopping) return;
    const ready: Ready = {
      ready: true,
      description: enabled.billing.description,
      notice,
      pair: host.pair(),
    };
    showReady(ready, interactive);
    report(ready);
  } catch (error) {
    await stop();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(await realpath(process.argv[1]).catch(() => process.argv[1]))
      .href
) {
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
  main().catch((e) => {
    console.error("Loop: " + e.message);
    report({ error: e.message });
    process.exitCode = 1;
  });
}
