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
import { createServer, request, type IncomingMessage } from "node:http";
import { chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { atomic, privateDir, secret } from "./state.js";

import { installDaemonLog } from "./daemon.js";

import { Tunnel, TunnelSupervisor, helper } from "./tunnel.js";
import { Relay } from "./relay.js";
import {
  CONNECTION_LOCK,
  CONNECTION_PROTOCOL,
  CONNECTION_RECORD,
  backendSocket,
  ensureRunDir,
  probeProof,
  readConnectionRecord,
  connectionControl,
  type Hello,
  type TunnelMode,
} from "./connection.js";

declare const __LOOP_RELEASE__: string | undefined;
// Set by the bundle build; a source checkout reports "development".
const RELEASE =
  typeof __LOOP_RELEASE__ === "string" ? __LOOP_RELEASE__ : "development";
// A launch that stops heartbeating (hung or killed) stops receiving traffic.
const LEASE_TIMEOUT_MS =
  Number(process.env.LOOP_TEST_LEASE_TIMEOUT_MS) || 15000;
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function probe(path: string, nonce: string) {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        socketPath: path,
        path: "/__loop/backend-probe?nonce=" + nonce,
        method: "GET",
        headers: { "x-loop-probe": "1" },
        timeout: 3000,
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (b) => {
          out += b;
          if (out.length > 1000) req.destroy();
        });
        res.on("end", () => {
          try {
            resolve(String(JSON.parse(out).proof ?? ""));
          } catch {
            reject(new Error("Invalid probe response"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Probe timed out")));
    req.on("error", reject);
    req.end();
  });
}
async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16000) throw new Error("Request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

export async function runConnectionService(
  argv: string[],
  report: (
    message: { ready: true; origin: string } | { error: string },
  ) => void = () => {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      root: { type: "string" },
      release: { type: "string" },
      "tunnel-name": { type: "string" },
      "public-url": { type: "string" },
      "tunnel-config": { type: "string" },
      log: { type: "boolean" },
    },
  });
  if (!values.dir) throw new Error("--dir is required");
  const dir = resolve(values.dir);
  privateDir(dir);
  if (values.log) installDaemonLog(join(dir, PROCESS_FILES.log));
  const root = resolve(values.root ?? dir);
  if (values["tunnel-name"] && !values["public-url"])
    throw new Error(
      "A named tunnel requires --public-url https://your-hostname.",
    );
  const mode: TunnelMode = values["tunnel-name"]
    ? {
        kind: "named",
        name: values["tunnel-name"],
        origin: new URL(values["public-url"]!).origin,
        ...(values["tunnel-config"] ? { config: values["tunnel-config"] } : {}),
      }
    : { kind: "quick" };
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
  let generation = 0;
  let pending: { generation: number; lease: string } | undefined;
  let backend:
    | { generation: number; lease: string; path: string; seen: number }
    | undefined;
  // The latest launch after it was withdrawn for silence or a refused
  // connection. Until a newer lease exists it may prove itself and return.
  let lapsed: { generation: number; lease: string } | undefined;
  let backendSince = startedAt;
  let stopping = false;

  const log = (message: string) =>
    console.log(`${new Date().toISOString()} ${message}`);
  const detach = (reason: string, recoverable = false) => {
    if (!backend) return;
    log(
      `Application generation ${backend.generation} ${reason}; requests receive 503 until a launch registers.`,
    );
    lapsed = recoverable
      ? { generation: backend.generation, lease: backend.lease }
      : undefined;
    backend = undefined;
    backendSince = Date.now();
    relay.setBackend(undefined);
  };
  relay.onUnreachable = (stale) => {
    if (backend?.generation === stale)
      detach("stopped accepting connections", true);
  };
  const expiry = setInterval(() => {
    if (backend && Date.now() - backend.seen > LEASE_TIMEOUT_MS)
      detach("stopped sending heartbeats", true);
  }, 1000);
  expiry.unref();

  const hello = (): Hello => ({
    protocol: CONNECTION_PROTOCOL,
    version: values.release ?? RELEASE,
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
    backend: {
      generation: backend?.generation ?? pending?.generation ?? generation,
      state: backend ? "ready" : pending ? "pending" : "none",
      since: backendSince,
    },
  });
  const owns = (input: any, entry?: { generation: number; lease: string }) =>
    !!entry &&
    input.generation === entry.generation &&
    typeof input.lease === "string" &&
    equal(input.lease, entry.lease);

  const operations: Record<string, (input: any) => Promise<[number, unknown]>> =
    {
      hello: async () => [200, hello()],
      // Issued to the launch holding the workspace lock. A new lease ends the
      // previous generation's forwarding, so two launches never both serve.
      lease: async () => {
        if (tunnelState !== "ready" || !origin)
          return [503, { error: "The tunnel has no confirmed address yet." }];
        detach("was replaced by a new launch");
        lapsed = undefined;
        pending = { generation: ++generation, lease: secret() };
        return [200, { ...pending, origin, instance }];
      },
      register: async (input) => {
        // A pending launch, or the latest one returning after a stall.
        const entry = owns(input, pending)
          ? pending
          : owns(input, lapsed)
            ? lapsed
            : undefined;
        if (!entry)
          return [409, { error: "Stale or unknown application generation." }];
        const path = backendSocket(run, input.socket);
        if (!path) return [400, { error: "Invalid application socket." }];
        const nonce = randomBytes(24).toString("base64url");
        const proof = await probe(path, nonce).catch(() => "");
        // Re-check: the lease may have been superseded while probing.
        if (
          (entry === pending ? !owns(input, pending) : !owns(input, lapsed)) ||
          !equal(
            proof,
            probeProof(entry.lease, instance, entry.generation, nonce),
          )
        )
          return [409, { error: "Application socket failed verification." }];
        backend = {
          generation: entry.generation,
          lease: entry.lease,
          path,
          seen: Date.now(),
        };
        backendSince = Date.now();
        if (entry === pending) pending = undefined;
        lapsed = undefined;
        relay.setBackend({ generation: backend.generation, path });
        log(
          `Application generation ${backend.generation} registered; forwarding resumed.`,
        );
        return [200, { origin }];
      },
      heartbeat: async (input) => {
        if (owns(input, backend)) backend!.seen = Date.now();
        else if (!owns(input, pending) && !owns(input, lapsed))
          return [409, { error: "Stale application generation." }];
        return [
          200,
          { origin, tunnel: tunnelState, registered: owns(input, backend) },
        ];
      },
      withdraw: async (input) => {
        if (owns(input, pending)) pending = undefined;
        else if (owns(input, lapsed)) lapsed = undefined;
        else if (owns(input, backend)) detach("is stopping");
        else return [409, { error: "Stale application generation." }];
        return [200, { withdrawn: true }];
      },
      shutdown: async () => {
        setImmediate(() => void shutdown(0));
        return [200, { stopping: true }];
      },
    };

  const controlServer = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const match = /^\/v1\/([a-z]+)$/.exec(req.url ?? "");
      if (
        req.method !== "POST" ||
        req.headers.origin ||
        !equal(req.headers.authorization ?? "", "Bearer " + token)
      )
        return reply(403, {
          error: "Connection control authentication required",
        });
      const operation =
        match && Object.hasOwn(operations, match[1]) && operations[match[1]];
      if (!operation) return reply(404, { error: "Unknown operation" });
      const [status, value] = await operation(await body(req));
      reply(status, value);
    } catch {
      reply(400, { error: "Invalid connection control request" });
    }
  });

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
      version: values.release ?? RELEASE,
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

const self = (() => {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return "";
  }
})();
if (import.meta.url === self) {
  const args = process.argv.slice(2);
  const send = (message: object) => {
    if (typeof process.send !== "function" || !process.connected) return;
    process.send(message, () => {
      if (process.connected) process.disconnect?.();
    });
  };
  const main =
    args[0] === "--install-helper"
      ? installHelper(args[1] ?? ".")
      : args[0] === "--health"
        ? health(args.slice(1))
        : runConnectionService(args, send);
  main.catch((error) => {
    console.error("Loop connection service: " + (error as Error).message);
    send({
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
