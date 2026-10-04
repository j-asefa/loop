#!/usr/bin/env node
import { automaticManagedStart } from "./start-selection.js";
import { parseArgs } from "node:util";
import { realpath, readFile, open } from "node:fs/promises";
import { openSync, closeSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve, dirname, isAbsolute } from "node:path";
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
const PACKAGE = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const { version: VERSION } = PACKAGE;
const names = Harness.options;
const REMOTE_MAIN = `${String(PACKAGE.repository?.url ?? "https://github.com/j-asefa/loop.git").replace(/^git\+/, "")}#main`;
// First launch may install provider CLIs and compile pinned HAPI before pairing.
const STARTUP_TIMEOUT_MS = 1800000;
// Tests shorten these waits; they never change which stop path runs.
const testWait = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const STOP_WAIT_MS = testWait("LOOP_TEST_STOP_WAIT_MS", 20000);
// How long a workspace that stopped answering gets to exit after SIGTERM.
const stopGraceMs = () => testWait("LOOP_TEST_STOP_GRACE_MS", 5000);
const LOG_POLL_MS = 500;
// Set only on the detached workspace process spawned by `loop start` or `loop <harness>`.
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
    "\nScan with your phone's camera to open Loop in your browser, then choose Pair and open Loop. Use Share → Add to Home Screen to install it. Scan a new code to reconnect after a tunnel address change. This single-use code expires in 2 minutes.",
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
    stopGraceMs(),
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
  const { stopManagedContainers } = await import("./local-runtime.js");
  await stopManagedContainers(dirname(dir));
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
      const { stopManagedContainers } = await import("./local-runtime.js");
      if (await stopManagedContainers(dirname(dir))) return;
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
function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} exited${signal ? ` from ${signal}` : ` with code ${code ?? "unknown"}`}.`,
          ),
        );
    });
  });
}
async function upgradeWorkspace(dir: string, requestedProject: string) {
  console.log(`Updating Loop from ${REMOTE_MAIN}…`);
  await runCommand("npm", ["install", "-g", REMOTE_MAIN], process.cwd());

  const running = await control(dir, "status").catch(() => undefined);
  const project = await realpath(running?.project ?? requestedProject);
  if (running) {
    console.log("Restarting the Loop workspace…");
    await stopWorkspace(dir);
  }
  await daemonize(dir, ["pi", "--project", project]);
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
      "acp-arg": { type: "string", multiple: true },
      billing: { type: "string" },
      resume: { type: "string" },
      json: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      foreground: { type: "boolean" },
      direct: { type: "boolean" },
      "local-only": { type: "boolean" },
      "public-url": { type: "string" },
      providers: { type: "string" },
      execution: { type: "string" },
      "tunnel-name": { type: "string" },
      "tunnel-config": { type: "string" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help) {
    console.log(`Loop ${VERSION} — one workspace for your native agents

loop start              Start this computer and show a pairing QR code.
                        Choose runtimes in the app; no harness is required.
loop                    Alias for loop start.
loop start [--direct] [--providers openai|anthropic|both|codex,claude,opencode,pi]
     [--execution native|docker|both]
     [--project PATH] [--tunnel-name NAME --public-url https://HOST]
loop server             Start the full server in the foreground.
loop codex|claude|pi|opencode [--project PATH] [--executable PATH]
     [--billing subscription|existing] [--resume NATIVE_SESSION]
     [--local-only | --public-url https://stable-origin] [--foreground]
                        Start this computer's workspace with that harness,
                        show a pairing code, then keep running in the
                        background. If the workspace is already running, the
                        harness is added to it; no new pairing is required.
loop acp --executable ABSOLUTE_PATH [--acp-arg ARG]...
                        Add a local ACP v1 agent. Sign in with the agent's
                        own CLI first; its own account pays for model use.
loop pair               Show a fresh pairing code. Scan it to pair a new
                        device, or scan it from the Loop app to reconnect
                        after the tunnel address changed.
loop upgrade            Install remote main, then restart Pi while preserving
                        the existing workspace and pairing state.
loop status [--json] | devices | devices revoke ID | doctor [--json]
loop logs [--follow] | stop | uninstall
loop service install|uninstall  Start automatically at login

Every project and enabled harness shares one workspace host and tunnel.
Phone disconnection does not stop native work; loop stop does.
Default billing is verified native subscription; existing mode retains your
selected native configuration and can incur API charges. No API fallback.
Native permissions, skills, plugins and project configuration are preserved.
Quick Tunnel URLs rotate. When that happens, run loop pair and scan the code
with your phone. Cloudflare terminates TLS. macOS/Linux, Node >=22.19.
--foreground keeps the workspace attached to this terminal (for service
managers and debugging).
--resume is an explicit desktop handoff of a native session you have stopped
elsewhere. The UI does not take over arbitrary live Desktop/TUI sessions.
Uninstall removes the package separately; workspace/native history is retained.`);
    return;
  }
  if (positionals[0] === "server") {
    const companion = (
      [
        "project",
        "executable",
        "billing",
        "resume",
        "local-only",
        "public-url",
        "foreground",
        "providers",
        "execution",
        "tunnel-name",
        "tunnel-config",
      ] as const
    ).find((k) => values[k] !== undefined);
    if (companion)
      throw new Error(
        `--${companion} applies to loop start or loop codex|claude|pi|opencode.`,
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
  let project = await realpath(resolve(values.project ?? process.cwd()));
  const action = !positionals.length
    ? "start"
    : positionals[0] === "claude-code"
      ? "claude"
      : positionals[0];
  if (action === "doctor") {
    const harnesses = await Promise.all(
      names
        .filter((n) => n !== "acp")
        .map((n) => discover(n, values.executable)),
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
            "ACP agents require --executable and negotiate their protocol at startup.",
            "Quick Tunnel needs outbound Cloudflare connectivity.",
          ],
        },
        null,
        values.json ? 0 : 2,
      ),
    );
    return;
  }
  if (action === "service") {
    const preferences = await readFile(join(dir, "preferences.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    if (positionals[1] === "install" && !preferences.project)
      throw new Error("Run loop start once before installing the service.");
    if (
      positionals[1] === "install" &&
      (await control(dir, "status").catch(() => undefined))
    )
      await stopWorkspace(dir);
    const { userService } = await import("./service.js");
    await userService(
      positionals[1],
      fileURLToPath(import.meta.url),
      root,
      preferences.project || project,
    );
    console.log(
      "Loop user service " +
        positionals[1] +
        " complete. Run loop pair when ready.",
    );
    return;
  }
  if (action === "logs") return logs(dir, !!values.follow);
  if (action === "upgrade") {
    if (positionals.length > 1)
      throw new Error("Unknown command. See loop --help.");
    await upgradeWorkspace(dir, project);
    return;
  }
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
          ? ["stopped", "Run loop start to open this workspace."]
          : recorded.state === "exited"
            ? [
                "crashed",
                "The workspace exited unexpectedly. Check loop logs, then run loop start again.",
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
      throw new Error("No responsive workspace host. Run loop start first.");
    });
    if (action === "pair") showPair(output);
    else console.log(JSON.stringify(output, null, values.json ? 0 : 2));
    return;
  }
  if (
    positionals.length > 1 ||
    (action !== "start" &&
      action !== "laptop" &&
      !names.includes(action as Harness))
  )
    throw new Error("Unknown command. See loop --help.");
  if (values["local-only"] && values["public-url"])
    throw new Error("Choose --local-only or --public-url.");
  const neutral = action === "start";
  if (
    neutral &&
    (values.resume ||
      values.executable ||
      values.billing ||
      values["acp-arg"]?.length)
  )
    throw new Error(
      "Runtime options belong to loop codex|claude|pi|opencode|acp. Use loop start without a runtime, then choose it in the app.",
    );
  const preferencesPath = join(dir, "preferences.json");
  const preferences = await readFile(preferencesPath, "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  if (values.direct && (!neutral || values.providers || values.execution))
    throw new Error(
      "Use --direct with loop start without provider or execution options.",
    );
  const automatic = automaticManagedStart(action, values, preferences);
  const managed =
    !values.direct &&
    (automatic ||
      action === "laptop" ||
      (neutral &&
        (!!values.providers ||
          !!values.execution ||
          (!!preferences.providers && !!preferences.execution))));
  const selected = (managed || neutral ? "codex" : action) as Harness;
  const running = await control(dir, "status").catch(() => undefined);
  if ((managed || neutral) && !values.project && preferences.project)
    project = await realpath(preferences.project);
  let managedChoices: import("./local-runtime.js").LocalChoices | undefined;
  if (managed) {
    let providers = automatic
      ? "codex,claude,opencode,pi"
      : (values.providers ?? preferences.providers);
    let execution = automatic
      ? "native"
      : (values.execution ?? preferences.execution);
    if ((!providers || !execution) && process.stdin.isTTY && !daemonChild) {
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        providers ||=
          (
            await input.question(
              "Providers [openai / anthropic / both / codex,claude,opencode,pi] (both): ",
            )
          ).trim() || "both";
        execution ||=
          (
            await input.question(
              "Run agents [native / docker / both] (native): ",
            )
          ).trim() || "native";
      } finally {
        input.close();
      }
    }
    if (
      process.env.LOOP_COMPANION_CONTAINER === "1" &&
      execution &&
      execution !== "native"
    )
      throw new Error(
        "Docker companion supports --execution native only; the container is the isolation boundary.",
      );
    const { choices } = await import("./local-runtime.js");
    managedChoices = choices(
      providers || "both",
      execution || "native",
      project,
    );
    values.providers = providers || "both";
    values.execution = execution || "native";
  }
  if (!values["local-only"]) {
    values["public-url"] ??= preferences.publicUrl;
    values["tunnel-name"] ??= preferences.tunnelName;
    values["tunnel-config"] ??= preferences.tunnelConfig;
  }
  if (values["tunnel-name"] && !values["public-url"])
    throw new Error(
      "A named tunnel requires --public-url https://your-hostname.",
    );
  if (selected === "acp" && !values.executable)
    throw new Error(
      "ACP setup requires --executable with an absolute local executable path.",
    );
  const probe =
    selected === "acp"
      ? (() => {
          const executable = statSync(values.executable!).isFile()
            ? values.executable!
            : "";
          if (
            !executable ||
            !isAbsolute(executable) ||
            !(statSync(executable).mode & 0o111)
          )
            throw new Error("Choose an executable local ACP agent file.");
          return {
            installed: true,
            supported: true,
            version: "ACP v1",
            executable,
            help: "",
          };
        })()
      : managed || neutral
        ? {
            installed: true,
            supported: true,
            version: "managed",
            executable: "codex",
            help: "",
          }
        : await discover(selected, values.executable);
  if (!probe.installed || !probe.supported || !probe.version)
    throw new Error(probe.help);
  let billing =
    values.billing ??
    preferences.billing?.[selected] ??
    (selected === "acp" ? "existing" : "subscription");
  if (selected === "acp" && billing !== "existing")
    throw new Error(
      "ACP uses the agent's own authentication and billing; choose --billing existing.",
    );
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
    ...(selected === "acp" ? { args: values["acp-arg"] || [] } : {}),
  };
  const remember = () =>
    atomic(preferencesPath, {
      ...preferences,
      ...(managed || neutral ? { project } : {}),
      ...(managed && !automatic
        ? { providers: values.providers, execution: values.execution }
        : {}),
      publicUrl: values["public-url"],
      tunnelName: values["tunnel-name"],
      tunnelConfig: values["tunnel-config"],
      billing:
        neutral && (!managed || automatic)
          ? preferences.billing
          : { ...preferences.billing, [selected]: billing },
    });
  if (running) {
    if (managed || neutral) {
      if (
        (managed &&
          !automatic &&
          (values.providers !== preferences.providers ||
            values.execution !== preferences.execution)) ||
        project !== (running.project ?? preferences.project)
      )
        throw new Error(
          "Run loop stop before changing the running workspace's providers, execution or project.",
        );
      showPair(await control(dir, "pair"));
      return;
    }
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
      ...(managed && !automatic
        ? [
            "laptop",
            "--providers",
            values.providers!,
            "--execution",
            values.execution!,
          ]
        : [neutral ? "start" : selected]),
      "--project",
      project,
      ...(neutral && (!managed || automatic)
        ? []
        : ["--executable", probe.executable, "--billing", billing]),
      ...(values.direct ? ["--direct"] : []),
      ...(values.resume ? ["--resume", values.resume] : []),
      ...(values["local-only"] ? ["--local-only"] : []),
      ...(values["public-url"] ? ["--public-url", values["public-url"]] : []),
      ...(values["tunnel-name"]
        ? ["--tunnel-name", values["tunnel-name"]]
        : []),
      ...(values["tunnel-config"]
        ? ["--tunnel-config", values["tunnel-config"]]
        : []),
    ]);
  const { workspaceLock } = await import("./lifecycle.js");
  const release = workspaceLock(dir);
  recordOwnedProcesses(join(dir, "children.json"));
  let runtime: import("./local-runtime.js").LocalRuntime | undefined;
  let host: import("./workspace-host.js").WorkspaceHost | undefined;
  let tunnel: TunnelSupervisor | undefined,
    stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await tunnel?.stop();
      await host?.close();
      await runtime?.close();
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
    if (managedChoices) {
      const { LocalRuntime } = await import("./local-runtime.js");
      runtime = new LocalRuntime(root, managedChoices);
      const { setRuntimeSetupState } = await import("./runtime-setup.js");
      setRuntimeSetupState("preparing");
    }
    const { WorkspaceHost } = await import("./workspace-host.js");
    if (stopping) return;
    host = new WorkspaceHost(dir, options);
    host.gateway.onStop = stop;
    const { migrateLegacy, resumeFromDesktop } =
      await import("./server/migration.js");
    const onListening = async (description: string) => {
      // Single-use pairing codes are shown on a terminal or sent over IPC, never
      // written to a log file or a service manager's journal.
      const interactive = !!process.stdout.isTTY;
      const gateway = host!;
      let notice: string | undefined;
      if (values["public-url"] && !values["tunnel-name"]) {
        gateway.setOrigin(values["public-url"]);
        notice = "Point the HTTPS tunnel to http://127.0.0.1:" + gateway.port;
      } else if (values["local-only"])
        notice = "Local-only: open this link on the desktop.";
      else {
        console.log("Preparing cloudflared tunnel…");
        tunnel = new TunnelSupervisor(
          (exited) =>
            new Tunnel(
              root,
              gateway.port,
              exited,
              values["tunnel-name"]
                ? {
                    name: values["tunnel-name"],
                    origin: values["public-url"]!,
                    config: values["tunnel-config"],
                  }
                : undefined,
            ),
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
        description,
        notice,
        pair: gateway.pair(),
      };
      // Persist the project before returning pairing while preparation continues.
      // Automatic runtime choices remain ephemeral in remember().
      if (runtime) remember();
      showReady(ready, interactive);
      report(ready);
    };
    const enabled = await host.start(
      options,
      async () => {
        await migrateLegacy(root);
        if (!stopping && values.resume)
          resumeFromDesktop(options, values.resume);
      },
      runtime
        ? async () => {
            const { prepareManagedRuntime } =
              await import("./managed-start.js");
            return prepareManagedRuntime(runtime!, () => stopping);
          }
        : undefined,
      neutral,
      runtime
        ? () =>
            onListening(
              "Workspace ready; execution is setting up. See loop logs --follow.",
            )
        : undefined,
    );
    if (stopping) {
      await host.close();
      return;
    }
    remember();
    if (stopping) return;
    if (runtime) console.log(enabled.billing.description);
    else await onListening(enabled.billing.description);
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
