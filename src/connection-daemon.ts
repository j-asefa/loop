#!/usr/bin/env node
import {
  PROCESS_FILES,
  LockBusyError,
  workspaceLock,
  identity,
  pidNamespace,
  recordOwnedProcesses,
} from "./process-records.js";
/**
 * Loop's per-workspace connection service: owns Cloudflared, the stable relay
 * listener and the private control socket. It is bundled into one immutable
 * file so a package upgrade cannot remove code it loads later. See
 * docs/pairing.md for the protocol and recovery rules.
 */
import { createServer } from "node:http";
import { jsonClient, jsonServer, BACKEND_PROBE } from "./local-control.js";
import { chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { reportReady, isEntrypoint } from "./local-startup.js";
import { randomUUID } from "node:crypto";
import { atomic, privateDir, secret } from "./state.js";

import { installDaemonLog } from "./daemon.js";

import { Tunnel, TunnelSupervisor, helper } from "./tunnel.js";
import { Relay } from "./relay.js";
import {
  parseLaunchArguments,
  type ConnectionLaunch,
} from "./launch-record.js";
import { ConnectionLeases } from "./connection-leases.js";
import {
  CONNECTION_LOCK,
  CONNECTION_PROTOCOL,
  CONNECTION_RECORD,
  backendSocket,
  ensureRunDir,
  readConnectionRecord,
  connectionControl,
  type Hello,
} from "./connection.js";

import { runningBuild } from "./shared/build.js";
// Set by the bundle build; a source checkout reports "development".
const RELEASE = runningBuild.release;
// A launch that stops heartbeating (hung or killed) stops receiving traffic.
const LEASE_TIMEOUT_MS =
  Number(process.env.LOOP_TEST_LEASE_TIMEOUT_MS) || 15000;
async function probe(path: string, nonce: string) {
  const value = await jsonClient({ socketPath: path })(
    BACKEND_PROBE.path + "?nonce=" + nonce,
    {
      method: "GET",
      headers: { [BACKEND_PROBE.header]: "1" },
      timeout: 3000,
      maxBytes: 1000,
    },
  );
  return String(value?.proof ?? "");
}
export async function runConnectionService(
  launch: ConnectionLaunch,
  report: (
    message: { ready: true; origin: string } | { error: string },
  ) => void = () => {},
) {
  const dir = resolve(launch.dir);
  privateDir(dir);
  if (launch.log) installDaemonLog(join(dir, PROCESS_FILES.log));
  const root = resolve(launch.root ?? dir);
  const mode = launch.mode;
  const releaseLock = workspaceLock(dir, CONNECTION_LOCK);
  // cloudflared is recorded so a full stop can find it after a crash here.
  recordOwnedProcesses(join(dir, PROCESS_FILES.children));
  const run = ensureRunDir(dir);
  const control = join(run, "control.sock");
  const token = secret();
  const instance = randomUUID();
  const startedAt = Date.now();
  const relay = new Relay();

  let origin: string | undefined;
  let tunnelState: Hello["tunnel"]["state"] = "starting";
  let tunnelSince = startedAt;
  let current: Tunnel | undefined;
  let stopping = false;

  const log = (message: string) =>
    console.log(`${new Date().toISOString()} ${message}`);
  const leases = new ConnectionLeases(instance, startedAt, {
    now: Date.now,
    timeout: LEASE_TIMEOUT_MS,
    socket: (name) => backendSocket(run, name),
    probe,
    setBackend: (backend) => relay.setBackend(backend),
    log,
  });
  relay.onUnreachable = (generation) => leases.unreachable(generation);
  const expiry = setInterval(() => leases.expire(), 1000);
  expiry.unref();

  const hello = (): Hello => ({
    protocol: CONNECTION_PROTOCOL,
    version: launch.release ?? RELEASE,
    instance,
    pid: process.pid,
    startedAt,
    mode,
    origin,
    relay: { host: "127.0.0.1", port: relay.port },
    tunnel: {
      state: tunnelState,
      pid: current?.pid,
      identity: current?.pid ? identity(current.pid) : undefined,
      since: tunnelSince,
    },
    backend: leases.status(),
  });

  const operations: Record<string, (input: any) => Promise<[number, unknown]>> =
    {
      hello: async () => [200, hello()],
      lease: async () => {
        if (tunnelState !== "ready" || !origin)
          return [503, { error: "The tunnel has no confirmed address yet." }];
        return [200, { ...leases.lease(), origin, instance }];
      },
      register: async (input) => {
        const [status, result] = await leases.register(input);
        return status === 200 ? [200, { origin }] : [status, result];
      },
      heartbeat: async (input) => {
        const [status, result] = leases.heartbeat(input);
        return status === 200
          ? [200, { origin, tunnel: tunnelState, ...result }]
          : [status, result];
      },
      withdraw: async (input) => leases.withdraw(input),
      shutdown: async () => {
        setImmediate(() => void shutdown(0));
        return [200, { stopping: true }];
      },
    };

  const controlServer = createServer(
    jsonServer(
      (path) => {
        const match = /^\/v1\/([a-z]+)$/.exec(path);
        return match && Object.hasOwn(operations, match[1])
          ? operations[match[1]]
          : undefined;
      },
      {
        token: () => token,
        authMessage: "Connection control authentication required",
        invalidMessage: "Invalid connection control request",
        body: { maxBytes: 16000, allowEmpty: true },
      },
    ),
  );

  async function shutdown(code: number) {
    if (stopping) return;
    stopping = true;
    clearInterval(expiry);
    log("Connection service stopping.");
    try {
      await supervisor.stop();
      await relay.close();
      controlServer.closeAllConnections();
      await new Promise<void>((r) => controlServer.close(() => r()));
    } finally {
      try {
        if (readConnectionRecord(dir)?.instance === instance)
          rmSync(join(dir, CONNECTION_RECORD), { force: true });
      } catch {
        /* Never remove a replacement owner's record. */
      }
      rmSync(control, { force: true });
      rmSync(join(dir, PROCESS_FILES.children), { force: true });
      releaseLock();
      process.exit(code);
    }
  }

  const named = mode.kind === "named" ? mode : undefined;
  const supervisor = new TunnelSupervisor(
    (exited) => {
      const tunnel = new Tunnel(
        root,
        relay.port,
        () => {
          tunnelState = "reconnecting";
          tunnelSince = Date.now();
          exited();
        },
        named,
      );
      current = tunnel;
      return tunnel;
    },
    (next, reconnected) => {
      const changed = !!origin && next !== origin;
      origin = next;
      tunnelState = "ready";
      tunnelSince = Date.now();
      if (reconnected)
        log(
          changed
            ? `Tunnel reconnected with a new address ${next}. Run loop pair and scan the code from the Loop app.`
            : "Tunnel reconnected at the same address.",
        );
    },
    { log },
  );

  try {
    // The relay never binds a public interface; cloudflared shares the host
    // or container network namespace with it.
    await relay.listen("127.0.0.1");
    // Only this process holds the lock, so a leftover socket is stale.
    rmSync(control, { force: true });
    await new Promise<void>((resolve, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(control, () => resolve());
    });
    chmodSync(control, 0o600);
    atomic(join(dir, CONNECTION_RECORD), {
      schema: 1,
      protocol: CONNECTION_PROTOCOL,
      version: launch.release ?? RELEASE,
      instance,
      pid: process.pid,
      identity: identity(process.pid) ?? "",
      pidNamespace: pidNamespace(),
      control,
      token,
      mode,
      startedAt,
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.once(signal, () => void shutdown(0));
    log(`Connection service ${instance} relaying on 127.0.0.1:${relay.port}.`);
    origin = await supervisor.start();
    tunnelState = "ready";
    tunnelSince = Date.now();
    log(`Tunnel ready at ${origin}.`);
    report({ ready: true, origin });
  } catch (error) {
    report({ error: (error as Error).message });
    console.error("Loop connection service: " + (error as Error).message);
    await shutdown(1);
  }
}

/** Seeds the pinned helper into an image or state root without starting anything. */
async function installHelper(root: string) {
  await helper(resolve(root));
}

if (isEntrypoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const main =
    args[0] === "--install-helper"
      ? installHelper(args[1] ?? ".")
      : args[0] === "--health"
        ? health(args.slice(1))
        : Promise.resolve().then(() =>
            runConnectionService(
              parseLaunchArguments("connection", args).launch,
              reportReady,
            ),
          );
  main.catch((error) => {
    console.error("Loop connection service: " + (error as Error).message);
    reportReady({
      error: (error as Error).message,
      ...(error instanceof LockBusyError ? { code: error.code } : {}),
    });
    process.exitCode = 1;
  });
}

/** Container health: the service answers and its tunnel has an address. */
async function health(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { dir: { type: "string" } },
  });
  const record = readConnectionRecord(resolve(values.dir ?? "."));
  if (!record) throw new Error("No connection service record");
  const status = await connectionControl<Hello>(record, "hello", {}, 3000);
  if (status.instance !== record.instance || status.tunnel.state !== "ready")
    throw new Error("Connection service is not ready");
}
