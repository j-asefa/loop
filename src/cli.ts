#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpath, readFile, open } from "node:fs/promises";
import { openSync, closeSync, statSync, existsSync } from "node:fs";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import qr from "qrcode-terminal";
import { Harness } from "./protocol.js";
import { privateDir, atomic } from "./state.js";
import {
  BackendLease,
  connectionDir,
  inspectConnection,
  publicConnection,
  type TunnelMode,
} from "./connection.js";
import {
  ensureConnection,
  stopConnection,
  tunnelArgs,
} from "./connection-launch.js";
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
import { preview, publicPreview, designPreview } from "./preview-context.js";
const PACKAGE = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const { version: VERSION } = PACKAGE;
const names = Harness.options;
const REMOTE_MAIN = `${String(PACKAGE.repository?.url ?? "https://github.com/j-asefa/loop.git").replace(/^git\+/, "")}#main`;
// Native account discovery is bounded; pairing is available before discovery.
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
  pair?: Pair;
  url?: string;
};
// Set by Loop's service definitions and the Docker companion: a service
// manager or sibling container owns the connection service.
const externalConnection = process.env.LOOP_CONNECTION_MANAGED === "external";
const LAUNCH_RECORD = "launch.json";
function showPair(pair: Pair) {
  console.log(
    "\nScan with your phone's camera to open Loop in your browser, then choose Pair and open Loop. Use Share → Add to Home Screen to install it. Scan a new code to reconnect after a tunnel address change. This single-use code expires in 2 minutes.",
  );
  qr.generate(pair.url, { small: true });
  console.log(pair.url);
  console.log("Anyone holding this link can control this workspace.\n");
}
function showReady(ready: Ready, withCode = true) {
  console.log(
    (preview
      ? `Loop preview ${preview.name} ready. `
      : "Loop workspace ready. ") + ready.description,
  );
  console.log(
    preview
      ? `Commands: loop preview open ${preview.name}, loop preview rebuild ${preview.name}, loop preview stop ${preview.name}.`
      : "Create agents in Loop; multiple agents may use the same project. Commands: loop status, loop pair, loop logs, loop stop.",
  );
  if (ready.notice) console.log(ready.notice);
  if (withCode && ready.pair) showPair(ready.pair);
  else if (!ready.pair && ready.url)
    console.log(
      `Same address: ${ready.url}. Paired devices stay signed in; no new pairing is needed.`,
    );
  else
    console.log(
      preview
        ? `Run loop preview open ${preview.name} to show a pairing code.`
        : "Run loop pair to show a pairing code.",
    );
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
  const { assertExecutionNamespace, retireStoppedExecution } =
    await import("./server/execution-ownership.js");
  assertExecutionNamespace(dir);
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
  // The worker is stopped. Hold its actual lock through final validation and
  // record retirement so a concurrent replacement cannot be erased by stop.
  // A killed Linux process can show a zombie leader while its other threads
  // are still releasing descriptors. Wait for the OS lock itself, never expire it.
  await retireStoppedExecution(dir, {
    lockWaitMs: 2000,
    cleanupWorkspace: () => forgetWorkspace(dir),
  });
}
/** Stops the application, its runners and managed containers; never the connection service. */
async function stopWorkspace(dir: string) {
  const recorded = await recordedWorkspace(dir);
  const answered = await control(dir, "stop").then(
    () => true,
    () => false,
  );
  if (!answered) {
    if (!recorded) {
      // A previous stop may have left records it couldn't resolve.
      if (
        (await recordedChildren(dir)).length ||
        existsSync(join(dir, "execution/owner.json"))
      )
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
  if (
    (await recordedChildren(dir)).length ||
    existsSync(join(dir, "execution/owner.json"))
  )
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
/** Full shutdown: application, runners, then the connection service and tunnel. */
async function stopAll(dir: string, connection: string) {
  let stopped = false;
  try {
    await stopWorkspace(dir);
    stopped = true;
  } catch (error) {
    if ((error as Error).message !== "No workspace is running.") throw error;
  }
  const service = await stopConnection(connection);
  if (service === "external")
    console.error(
      "The connection service belongs to another container or service manager and was left running.",
    );
  if (!stopped && !service) throw new Error("No workspace is running.");
}

const execFileAsync = promisify(execFile);
/** The launch to repeat on restart; written by each application launch. */
async function launchArgs(dir: string) {
  const saved = await readFile(join(dir, LAUNCH_RECORD), "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  if (
    saved?.schema === 1 &&
    Array.isArray(saved.args) &&
    saved.args.every((a: unknown) => typeof a === "string")
  )
    return saved.args as string[];
  return ["start"];
}

/**
 * Replaces the application with this CLI's installed build. The connection
 * service, its cloudflared and the public address stay; so do paired devices.
 */
async function restartWorkspace(
  dir: string,
  connection: string,
  root: string,
  force: boolean,
  upgradedFrom?: string,
) {
  if (process.env.LOOP_COMPANION_CONTAINER === "1")
    throw new Error(
      "In the Docker companion, restart the application container instead: docker compose -f compose.companion.yaml restart loop-companion",
    );
  const status = await control(dir, "status").catch(() => undefined);
  const service = await inspectConnection(connection);
  let hung = false;
  // The application reports its own supervisor, which it cannot do once it is
  // hung or gone -- exactly when a restart matters. The installed unit says so
  // too, and routing to the manager is what keeps the restart inside the unit:
  // starting a detached application instead leaves the manager relaunching its
  // own copy, which then dies on the workspace lock, over and over.
  const { installedSupervisor } = await import("./service.js");
  // LOOP_SERVICE can be inherited by a fixture or a second workspace. Its
  // status is not proof that the installed unit owns this root: only route
  // through the manager when that unit's LOOP_HOME matches the request.
  const supervisor = await installedSupervisor(root);
  if (!status) {
    const recorded = await recordedWorkspace(dir);
    if (recorded?.state === "unknown")
      throw new Error(
        `Workspace process ${recorded.pid} is not responding and can't be confirmed as Loop's. Check it with ps.`,
      );
    hung = recorded?.state === "running";
    if (hung && !force)
      throw new Error(
        "The application is not responding. Run loop restart --force to stop it (the connection and its address are kept).",
      );
    if (!hung && !supervisor && service.state !== "running")
      throw new Error("No workspace is running. Run loop start.");
    if (supervisor)
      return restartService(
        dir,
        root,
        { supervisor, pid: recorded?.pid },
        upgradedFrom,
      );
    if (!hung)
      console.log(
        "The application is not running; starting it behind the existing connection.",
      );
  } else {
    const active = Number(status.activeRuns?.n ?? 0);
    if (active > 0 && !force)
      throw new Error(
        `${active} run(s) are active. Wait for them to finish, or run loop restart --force: interrupted work is marked for review and never resent automatically.`,
      );
    if (supervisor)
      return restartService(dir, root, { ...status, supervisor }, upgradedFrom);
  }
  const args = await launchArgs(dir);
  if (status || hung) {
    console.log("Restarting the Loop application…");
    // Application and runners only: the connection service is in its own
    // process group and absent from the application's ownership records.
    await stopWorkspace(dir);
  }
  await daemonize(dir, args, { restart: true, upgradedFrom });
}

/** An installed service restarts only its application unit. */
async function restartService(
  dir: string,
  root: string,
  status: any,
  upgradedFrom?: string,
) {
  const uid = process.getuid!();
  const { installedServiceNames, SERVICES } = await import("./service.js");
  const names =
    (await installedServiceNames(root)) ??
    (process.platform === "darwin" ? SERVICES.darwin : SERVICES.linux);
  // An upgrade installs the new build in npm's global prefix while the service
  // entry still names the build it was installed from, often a checkout.
  // Restarting that entry would relaunch the old code, so point it at this CLI
  // first. The connection unit, its cloudflared and the address stay up.
  // An ordinary restart must retain the installed entrypoint: this CLI may
  // belong to a development checkout or a different installation.
  const pointed = upgradedFrom
    ? await import("./service.js").then((m) =>
        m.repointAppService(fileURLToPath(import.meta.url), root),
      )
    : "unchanged";
  if (pointed === "repointed")
    console.log("Pointed the Loop service at the newly installed build.");
  else if (status.supervisor === "launchd")
    await runCommand(
      "launchctl",
      ["kickstart", "-k", `gui/${uid}/${names.app}`],
      process.cwd(),
    );
  else
    await runCommand(
      "systemctl",
      ["--user", "restart", names.app],
      process.cwd(),
    );
  const end = Date.now() + STARTUP_TIMEOUT_MS;
  let last: any;
  for (;;) {
    const next = await control(dir, "status").catch(() => undefined);
    if (next) last = next;
    // Only a managed tunnel has a lease to register; local-only and
    // user-managed proxy launches are ready once the application is.
    const tunnel = ["quick", "named"].includes(next?.connection?.mode);
    if (
      next?.pid &&
      next.pid !== status.pid &&
      (!tunnel || next.connection.registered) &&
      // An upgrade is only done once the new release is the one serving: a
      // changed PID alone would accept a service that relaunched the old build.
      (!upgradedFrom || next.release === VERSION)
    ) {
      console.log(
        next.url
          ? `Loop restarted under its service. Same address: ${next.url}. Paired devices stay signed in.`
          : "Loop restarted under its service. Paired devices stay signed in.",
      );
      return;
    }
    if (Date.now() > end)
      throw new Error(
        upgradedFrom &&
          last?.pid &&
          last.pid !== status.pid &&
          last.release !== VERSION
          ? `The service restarted Loop ${last.release}, not the installed ${VERSION}: its service entry launches a different installation. Run loop service install from the new build, then loop restart.`
          : "The restarted service did not become ready. See loop logs.",
      );
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Quick and named tunnels run in the connection service; local-only and a
 * user-managed --public-url proxy keep the in-process loopback gateway.
 */
function tunnelModeOf(values: {
  "local-only"?: boolean;
  "public-url"?: string;
  "tunnel-name"?: string;
  "tunnel-config"?: string;
}): TunnelMode | undefined {
  if (values["local-only"] || (values["public-url"] && !values["tunnel-name"]))
    return undefined;
  return values["tunnel-name"]
    ? {
        kind: "named",
        name: values["tunnel-name"],
        origin: new URL(values["public-url"]!).origin,
        ...(values["tunnel-config"] ? { config: values["tunnel-config"] } : {}),
      }
    : { kind: "quick" };
}

/**
 * The connection service can exit while its application keeps running. loop
 * start then starts it again (or waits for its service manager), and waits for
 * the application to reattach and adopt the service's confirmed address, so a
 * pairing code is only issued for an address that serves the application.
 */
async function recoverConnection(
  dir: string,
  root: string,
  connection: string,
  running: any,
  fallback: TunnelMode | undefined,
) {
  if (!["quick", "named"].includes(running.connection?.mode)) return;
  const found = await inspectConnection(connection);
  if (
    found.state === "running" &&
    found.hello.tunnel.state === "ready" &&
    running.connection.registered &&
    running.url === found.hello.origin
  )
    return;
  const mode = found.state === "absent" ? fallback : found.record.mode;
  if (!mode) return;
  if (found.state !== "running")
    console.log("The Loop connection service stopped; starting it again…");
  const service = await ensureConnection({
    root,
    dir: connection,
    mode,
    release: VERSION,
    // An installed service's connection unit is restarted by its manager.
    external: externalConnection || !!running.supervisor,
    log: console.log,
  });
  const end = Date.now() + testWait("LOOP_TEST_CONNECTION_WAIT_MS", 120000);
  for (;;) {
    const current = await control(dir, "status").catch(() => undefined);
    if (
      current?.connection?.registered &&
      current.url === service.hello.origin
    ) {
      if (current.url !== running.url)
        console.log(
          "The public address changed to " +
            current.url +
            ". Scan the new code from the Loop app to reconnect.",
        );
      return;
    }
    if (Date.now() > end)
      throw new Error(
        "The running application did not reconnect to the connection service. Run loop restart (the address is kept).",
      );
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Installs the new release while the current application keeps serving, then
 * hands the restart to the newly installed CLI so the new build is launched.
 */
async function upgradeWorkspace(
  dir: string,
  connection: string,
  source: string,
  force: boolean,
) {
  const status = await control(dir, "status").catch(() => undefined);
  const active = Number(status?.activeRuns?.n ?? 0);
  if (active > 0 && !force)
    throw new Error(
      `${active} run(s) are active. Wait for them to finish, or run loop upgrade --force.`,
    );
  console.log(`Installing Loop from ${source}…`);
  await runCommand("npm", ["install", "-g", source], process.cwd());
  const prefix = (await execFileAsync("npm", ["prefix", "-g"])).stdout.trim();
  const cli = join(
    prefix,
    "lib",
    "node_modules",
    PACKAGE.name,
    "dist",
    "cli.js",
  );
  const installed = (
    await execFileAsync(process.execPath, [cli, "--version"], {
      timeout: 60000,
    })
  ).stdout.trim();
  console.log(`Installed Loop ${installed}.`);
  const service = await inspectConnection(connection);
  if (!status && service.state !== "running") {
    console.log("No workspace is running. Run loop start to open it.");
    return;
  }
  await runCommand(
    process.execPath,
    [cli, "restart", "--upgraded-from", VERSION, ...(force ? ["--force"] : [])],
    process.cwd(),
  );
}
async function daemonize(
  dir: string,
  args: string[],
  restart?: { restart: true; upgradedFrom?: string },
) {
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
        env: {
          ...process.env,
          LOOP_DAEMON_CHILD: "1",
          ...(restart ? { LOOP_LAUNCH_REASON: "restart" } : {}),
        },
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
    if (restart?.upgradedFrom)
      console.log(`Upgraded from Loop ${restart.upgradedFrom} to ${VERSION}.`);
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
  if (process.argv[2] === "preview") {
    const { previewCli } = await import("./preview-cli.js");
    return previewCli(process.argv.slice(3));
  }
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
      "local-only": { type: "boolean" },
      "public-url": { type: "string" },
      providers: { type: "string" },
      "tunnel-name": { type: "string" },
      "tunnel-config": { type: "string" },
      force: { type: "boolean" },
      from: { type: "string" },
      "upgraded-from": { type: "string" },
      "stopped-generation": { type: "string" },
      fleet: { type: "boolean" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help) {
    console.log(`Loop ${VERSION} — one workspace for your native agents

loop start              Start this computer and show a pairing QR code.
                        Discovers installed harnesses and reuses their native sign-in.
loop                  Alias for loop start.
loop start [--providers installed|codex,claude,opencode,pi,antigravity,muse,grok]
     [--project PATH] [--tunnel-name NAME --public-url https://HOST]
     [--fleet]          Also run the experimental multi-machine fleet
                        extension (off unless given). See docs/pairing.md.
loop codex|claude|pi|opencode|antigravity|muse|grok [--project PATH] [--executable PATH]
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
loop restart [--force]  Restart the application into the installed build. The
                        tunnel, its address and paired devices are kept.
                        Refuses while runs are active unless --force.
loop upgrade [--from PACKAGE] [--force]
                        Install remote main (or PACKAGE) while Loop keeps
                        running, then restart into it with the same
                        projects, runtimes, billing and address.
loop status [--json] | devices | devices revoke ID | doctor [--json]
loop logs [--follow] | stop | uninstall
loop stop               Stop Loop completely, including its tunnel. The next
                        start may get a new Quick Tunnel address.
loop recover-execution [--stopped-generation UUID]
                        Inspect a retained execution owner. After independently
                        confirming its prior host/container and processes stopped,
                        retire that namespace lifetime's records by generation.
loop service install|uninstall  Start automatically at login
loop preview --help      Create, open, rebuild and discard isolated experiments.

Every project and enabled harness shares one workspace host and tunnel.
A separate connection service keeps the tunnel and its address while the
application restarts or upgrades. Phone disconnection does not stop native
work; loop stop does.
Default billing is verified native subscription; existing mode retains your
selected native configuration and can incur API charges. No API fallback.
Native permissions, skills, plugins and project configuration are preserved.
Quick Tunnel addresses change after loop stop, a reboot or a tunnel failure.
When that happens, run loop pair and scan the code from the Loop app.
Cloudflare terminates TLS. macOS/Linux, Node >=22.19.
--foreground keeps the workspace attached to this terminal (for service
managers and debugging).
--resume is an explicit desktop handoff of a native session you have stopped
elsewhere. The UI does not take over arbitrary live Desktop/TUI sessions.
Uninstall removes the package separately; workspace/native history is retained.`);
    return;
  }
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("This release supports macOS and Linux.");
  const root = resolve(
    process.env.LOOP_HOME ?? join(join(homedir(), ".local", "state"), "loop"),
  );
  const dir = join(root, "workspace");
  privateDir(dir);
  const connection = connectionDir(root);
  const logPath = join(dir, "daemon.log");
  if (daemonChild) installDaemonLog(logPath);
  let project = await realpath(resolve(values.project ?? process.cwd()));
  const action = positionals[0] ?? "start";
  if (values["stopped-generation"] && action !== "recover-execution")
    throw new Error(
      "--stopped-generation applies only to loop recover-execution.",
    );
  if (
    values.fleet &&
    action !== "restart" &&
    [
      "connection",
      "devices",
      "doctor",
      "logs",
      "pair",
      "recover-execution",
      "service",
      "status",
      "stop",
      "uninstall",
      "upgrade",
    ].includes(action)
  )
    throw new Error(
      "--fleet applies to loop start or loop codex|claude|pi|opencode|antigravity|muse|grok. Run loop stop, then loop start --fleet.",
    );
  if (action === "recover-execution") {
    if (positionals.length !== 1)
      throw new Error(
        "Use loop recover-execution [--stopped-generation UUID].",
      );
    const { recordedExecutionOwner, recoverStoppedExecution } =
      await import("./server/execution-ownership.js");
    if (values["stopped-generation"]) {
      const archive = recoverStoppedExecution(
        dir,
        values["stopped-generation"],
      );
      console.log(
        `Execution records archived at ${archive}. Workspace data is retained; run loop start when ready.`,
      );
    } else {
      const owner = recordedExecutionOwner(dir);
      if (!owner)
        console.log("No retained execution owner. No records changed.");
      else {
        console.log(
          JSON.stringify({
            generation: owner.generation,
            namespace: owner.namespace,
            namespaceIdentity: owner.namespaceIdentity,
            pid: owner.pid,
          }),
        );
        console.log(
          "Only after independently confirming the prior host/container and every process in that namespace lifetime stopped, run loop recover-execution --stopped-generation " +
            owner.generation +
            ". This also applies after an unclean host reboot. A free lock alone does not prove native children stopped.",
        );
      }
    }
    return;
  }
  if (preview && ["upgrade", "service", "uninstall"].includes(action))
    throw new Error(
      "Manage experiments with loop preview. Preview builds cannot replace the global installation or login service.",
    );
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
          connection: publicConnection(await inspectConnection(connection)),
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
  if (action === "connection") {
    // Run by Loop's service definitions and container: the connection service
    // in the foreground, independent of the application's lifecycle.
    if (!values.foreground || positionals.length > 1)
      throw new Error(
        "loop connection --foreground runs the connection service for a service manager. Use loop start instead.",
      );
    const { runConnectionService } = await import("./connection-daemon.js");
    await runConnectionService([
      "--dir",
      connection,
      "--root",
      root,
      "--release",
      VERSION,
      ...(values["tunnel-name"]
        ? tunnelArgs({
            kind: "named",
            name: values["tunnel-name"],
            origin: values["public-url"] ?? "",
            config: values["tunnel-config"],
          })
        : []),
    ]);
    return;
  }
  if (action === "service") {
    const preferences = await readFile(join(dir, "preferences.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    const launched = await readFile(join(dir, LAUNCH_RECORD), "utf8").then(
      () => true,
      () => false,
    );
    if (positionals[1] === "install" && !preferences.project && !launched)
      throw new Error("Run loop start once before installing the service.");
    // The installed services own a new connection service, so the current
    // one stops too; the Quick Tunnel address changes once.
    if (positionals[1] === "install")
      await stopAll(dir, connection).catch((error) => {
        if ((error as Error).message !== "No workspace is running.")
          throw error;
      });
    // The service repeats the saved launch, as loop restart does.
    const launch = await launchArgs(dir);
    const option = (name: string) => {
      const i = launch.indexOf(name);
      return i >= 0 ? launch[i + 1] : undefined;
    };
    const tunnelName = option("--tunnel-name") ?? preferences.tunnelName;
    const publicUrl = option("--public-url") ?? preferences.publicUrl;
    const tunnel =
      launch.includes("--local-only") || (publicUrl && !tunnelName)
        ? null
        : tunnelName
          ? tunnelArgs({
              kind: "named",
              name: tunnelName,
              origin: publicUrl,
              config: option("--tunnel-config") ?? preferences.tunnelConfig,
            })
          : [];
    const { userService } = await import("./service.js");
    await userService(
      positionals[1],
      fileURLToPath(import.meta.url),
      root,
      option("--project") ?? preferences.project ?? project,
      tunnel,
      launch,
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
    await upgradeWorkspace(
      dir,
      connection,
      values.from ?? REMOTE_MAIN,
      !!values.force,
    );
    return;
  }
  if (action === "restart") {
    if (positionals.length > 1)
      throw new Error("Unknown command. See loop --help.");
    if (values.fleet)
      throw new Error(
        "loop restart repeats the running launch. To change fleets, run loop stop, then loop start --fleet.",
      );
    await restartWorkspace(
      dir,
      connection,
      root,
      !!values.force,
      values["upgraded-from"],
    );
    return;
  }
  if (["pair", "status", "devices", "stop", "uninstall"].includes(action)) {
    if (action === "uninstall") {
      if (
        (await control(dir, "status").catch(() => undefined)) ||
        (await inspectConnection(connection)).state === "running"
      )
        throw new Error("Run loop stop first.");
      console.log(
        "Workspace and native history retained at " +
          root +
          ". Remove the executable with npm uninstall -g @j-asefa/loop. Back up this directory before manually removing workspace data.",
      );
      return;
    }
    if (action === "pair") {
      // A code is only useful at the tunnel's confirmed, current address. The
      // connection service can exit while its application keeps running, and
      // the application still reports the address it last held: without this
      // check loop pair hands out a link to a tunnel that no longer exists.
      // Local-only and user-managed proxy launches have no service to check.
      const service = await inspectConnection(connection);
      const running = await control(dir, "status").catch(() => undefined);
      const managed = ["quick", "named"].includes(running?.connection?.mode);
      if (managed && service.state !== "running")
        throw new Error(
          "The Loop connection service is not running, so this workspace has no public address. Run loop start to restore it (the application keeps running), then run loop pair.",
        );
      if (service.state === "running") {
        if (service.hello.tunnel.state !== "ready")
          throw new Error(
            "The tunnel is reconnecting, so its address isn't confirmed yet. Run loop pair again shortly.",
          );
        // The application applies a changed address on its next heartbeat.
        let current = running;
        for (let i = 0; i < 25; i++) {
          if (
            !current ||
            (current.url === service.hello.origin &&
              (!managed || current.connection.registered))
          )
            break;
          await new Promise((r) => setTimeout(r, 200));
          current = await control(dir, "status").catch(() => undefined);
        }
        if (
          managed &&
          current &&
          !(
            current.url === service.hello.origin &&
            current.connection.registered
          )
        )
          throw new Error(
            "The application has not taken the connection service's address yet, so a code would point at an address it does not serve. Run loop start to reconnect it (or loop restart), then run loop pair.",
          );
      }
    }
    if (action === "stop") {
      await stopAll(dir, connection);
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
        const service = publicConnection(await inspectConnection(connection));
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
        // The tunnel can outlive the application: report its unchanged address.
        const serving = service.state === "running";
        return {
          workspace: true,
          state,
          stateRoot: root,
          logs: logPath,
          message:
            serving && state === "stopped"
              ? "The application is stopped, but the connection service keeps its address. Run loop start or loop restart to serve it again."
              : message,
          ...(serving && "url" in service ? { url: service.url } : {}),
          serverReady: false,
          connection: service,
        };
      }
      throw new Error("No responsive workspace host. Run loop start first.");
    });
    if (
      action === "status" &&
      output.pid &&
      output.connection?.mode !== "local"
    )
      output.connection = {
        ...output.connection,
        service: publicConnection(await inspectConnection(connection)),
      };
    if (action === "pair") showPair(output);
    else console.log(JSON.stringify(output, null, values.json ? 0 : 2));
    return;
  }
  if (
    positionals.length > 1 ||
    (action !== "start" && !names.includes(action as Harness))
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
      "Runtime options belong to loop codex|claude|pi|opencode|antigravity|muse|grok|acp. Use loop start without a runtime, then choose it in the app.",
    );
  const preferencesPath = join(dir, "preferences.json");
  const preferences = await readFile(preferencesPath, "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  const selected = (neutral ? "codex" : action) as Harness;
  const running = await control(dir, "status").catch(() => undefined);
  if (neutral && !values.project && preferences.project)
    project = await realpath(preferences.project);
  const { selectedHarnesses } = await import("./start-selection.js");
  const providers = selectedHarnesses(
    values.providers ?? preferences.providers ?? "installed",
  );
  if (!values["local-only"]) {
    values["public-url"] ??= preferences.publicUrl;
    values["tunnel-name"] ??= preferences.tunnelName;
    values["tunnel-config"] ??= preferences.tunnelConfig;
    // A path: resolved once, so a restart from another directory reads the same file.
    if (values["tunnel-config"])
      values["tunnel-config"] = resolve(values["tunnel-config"]);
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
          const executable = values.executable!;
          const stat = isAbsolute(executable)
            ? statSync(executable, { throwIfNoEntry: false })
            : undefined;
          if (!stat?.isFile() || !(stat.mode & 0o111))
            throw new Error("Choose an executable local ACP agent file.");
          return {
            installed: true,
            supported: true,
            version: "ACP v1",
            executable,
            help: "",
          };
        })()
      : neutral
        ? {
            installed: true,
            supported: true,
            version: "workspace",
            executable: "codex",
            help: "",
          }
        : await discover(selected, values.executable);
  if (!probe.installed || !probe.supported || !probe.version)
    throw new Error(probe.help);
  let billing =
    values.billing ??
    preferences.billing?.[selected] ??
    (["acp", "antigravity", "muse", "grok"].includes(selected)
      ? "existing"
      : "subscription");
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
      ...(neutral ? { project } : {}),
      ...(neutral
        ? {
            providers: values.providers ?? preferences.providers ?? "installed",
          }
        : {}),
      publicUrl: values["public-url"],
      tunnelName: values["tunnel-name"],
      tunnelConfig: values["tunnel-config"],
      billing: neutral
        ? preferences.billing
        : { ...preferences.billing, [selected]: billing },
    });
  if (running) {
    await recoverConnection(
      dir,
      root,
      connection,
      running,
      tunnelModeOf(values),
    );
    // Fleets are a start option of the running launch, never a live change.
    if (values.fleet && !(await launchArgs(dir)).includes("--fleet"))
      throw new Error(
        "Fleets are off in the running workspace. Run loop stop, then loop start --fleet.",
      );
    if (neutral) {
      if (
        (values.providers &&
          [...providers].sort().join() !==
            selectedHarnesses(preferences.providers ?? "installed")
              .sort()
              .join()) ||
        project !== (running.project ?? preferences.project)
      )
        throw new Error(
          "Run loop stop before changing the running workspace's providers or project.",
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
  // The resolved launch (absolute project, executable and tunnel config):
  // repeated by the background child, loop restart and loop upgrade from any
  // working directory. A --resume handoff is one-time and not repeated.
  const launch = [
    neutral ? "start" : selected,
    "--project",
    project,
    ...(neutral
      ? []
      : ["--executable", probe.executable, "--billing", billing]),
    ...(selected === "acp"
      ? (values["acp-arg"] ?? []).map((arg) => "--acp-arg=" + arg)
      : []),
    ...(neutral ? ["--providers", providers.join(",")] : []),
    ...(values["local-only"] ? ["--local-only"] : []),
    ...(values["public-url"] ? ["--public-url", values["public-url"]] : []),
    ...(values["tunnel-name"] ? ["--tunnel-name", values["tunnel-name"]] : []),
    ...(values["tunnel-config"]
      ? ["--tunnel-config", values["tunnel-config"]]
      : []),
    ...(values.fleet ? ["--fleet"] : []),
  ];
  if (!values.foreground && !daemonChild)
    return daemonize(dir, [
      ...launch,
      ...(values.resume ? ["--resume", values.resume] : []),
    ]);
  const { workspaceLock } = await import("./lifecycle.js");
  const release = workspaceLock(dir);
  recordOwnedProcesses(join(dir, "children.json"));
  atomic(join(dir, LAUNCH_RECORD), {
    schema: 1,
    args: launch,
    version: VERSION,
  });
  const tunnelMode = tunnelModeOf(values);
  const restarting = process.env.LOOP_LAUNCH_REASON === "restart";
  let host: import("./workspace-host.js").WorkspaceHost | undefined;
  let lease: BackendLease | undefined,
    connectionCreated = false,
    stopping = false;
  const stop = async (wholeStack = false) => {
    if (stopping) return;
    stopping = true;
    try {
      // Withdraw first: new requests get the relay's 503 while this drains.
      await lease?.withdraw();
      await host?.close();
    } finally {
      release();
    }
    if (wholeStack) await stopConnection(connection).catch(() => {});
  };
  // Ending a terminal-owned foreground session stops what it started,
  // including the tunnel. Background and service-managed applications stop
  // alone; loop stop ends the connection service separately.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void stop(
        !!values.foreground &&
          !daemonChild &&
          !externalConnection &&
          connectionCreated,
      );
    });
  try {
    process.env.LOOP_DATA_DIR = dir;
    const { WorkspaceHost } = await import("./workspace-host.js");
    if (stopping) return;
    host = new WorkspaceHost(dir, { ...options, fleet: !!values.fleet });
    host.gateway.onStop = () => stop();
    if (tunnelMode) {
      console.log(
        externalConnection
          ? "Connecting to the Loop connection service…"
          : "Preparing the Loop connection service and cloudflared tunnel…",
      );
      const found = await ensureConnection({
        root,
        dir: connection,
        mode: tunnelMode,
        release: VERSION,
        external: externalConnection,
        log: console.log,
      });
      connectionCreated = found.created;
      if (stopping) return;
      lease = new BackendLease(connection, found.record);
      await lease.acquire();
      host.listenOptions = { socket: lease.socket, probe: lease.probe };
    }
    host.statusExtras = () => ({
      release: VERSION,
      ...(publicPreview ? { preview: publicPreview } : {}),
      supervisor: process.env.LOOP_SERVICE || undefined,
      connection: tunnelMode
        ? {
            mode: tunnelMode.kind,
            generation: lease?.generation,
            registered: !!lease?.attached,
          }
        : { mode: values["local-only"] ? "local" : "external-proxy" },
    });
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
      else if (lease) {
        // Apply the service's confirmed origin before traffic can arrive, so
        // Host/Origin checks and Secure cookies match what browsers hold.
        gateway.setOrigin(lease.origin);
        lease.onOrigin = (origin) => {
          gateway.setOrigin(origin);
          console.log(
            "Quick Tunnel address changed to " +
              origin +
              ". Run loop pair and scan the code from the Loop app to reconnect.",
          );
          if (interactive) showPair(gateway.pair());
        };
        await lease.register();
      }
      if (stopping) return;
      // An application restart behind the same address needs no new pairing.
      const quiet = restarting && !!lease && !connectionCreated;
      const ready: Ready = {
        ready: true,
        description,
        notice,
        url: gateway.origin,
        ...(quiet ? {} : { pair: gateway.pair() }),
      };
      // Persist the project before returning pairing while preparation continues.
      // Automatic runtime choices remain ephemeral in remember().
      remember();
      showReady(ready, interactive);
      report(ready);
    };
    const enabled = await host.start(
      options,
      async () => {
        await migrateLegacy(root);
        if (!stopping && values.resume)
          await resumeFromDesktop(options, values.resume);
      },
      neutral
        ? async () => {
            const { prepareLocalHarnesses } =
              await import("./server/local-harnesses.js");
            return prepareLocalHarnesses(project, providers, () => stopping);
          }
        : undefined,
      neutral,
      neutral
        ? () =>
            onListening(
              designPreview
                ? "Design preview ready. Sample data and simulated replies."
                : "Discovering installed harnesses; your workspace is ready.",
            )
        : undefined,
    );
    if (stopping) {
      await host.close();
      return;
    }
    remember();
    if (stopping) return;
    if (neutral) console.log(enabled.billing.description);
    else await onListening(enabled.billing.description);
  } catch (error) {
    await stop(!daemonChild && !externalConnection && connectionCreated);
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
