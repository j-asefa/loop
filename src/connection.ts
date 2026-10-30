import "../deployment/environment.mjs";
/**
 * Shared records and private control protocol of the per-workspace connection
 * service. The service owns Cloudflared and a stable local relay; the Loop55
 * application registers behind it once per launch. See docs/pairing.md.
 */
import { request } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { pidNamespace } from "./lifecycle.js";
import { processState } from "./daemon.js";

/** Bumped only for incompatible control changes; see compatibility in docs/pairing.md. */
export const CONNECTION_PROTOCOL = 1;
export const CONNECTION_RECORD = "connection.json";
export const CONNECTION_LOCK = {
  name: "connection.lock",
  owner:
    "Another Loop55 connection service is starting or running for this workspace. Wait for it, then retry; no process was stopped.",
};
// Unix socket paths are limited to 104 bytes on macOS and 108 on Linux.
const MAX_SOCKET_PATH = 100;
const BACKEND_SOCKET = /^app-[a-f0-9]{16}\.sock$/;

export function connectionDir(root: string) {
  return resolve(process.env.LOOP55_CONNECTION_DIR || join(root, "connection"));
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      `Refusing ${path}: the connection service needs a private directory owned by this user.`,
    );
  chmodSync(path, 0o700);
}

/**
 * Private directory holding the control socket and each application launch's
 * socket. A state path too long for Unix sockets uses a per-user directory
 * under /tmp, keyed by the connection directory.
 */
export function runDir(dir: string) {
  const local = join(dir, "run");
  if (
    Buffer.byteLength(join(local, "app-0123456789abcdef.sock")) <=
    MAX_SOCKET_PATH
  )
    return local;
  return join(
    "/tmp",
    `loop55-${process.getuid?.() ?? 0}`,
    createHash("sha256").update(dir).digest("hex").slice(0, 16),
  );
}
export function ensureRunDir(dir: string) {
  const run = runDir(dir);
  if (dirname(run) !== dir) privateDirectory(dirname(run));
  privateDirectory(run);
  return run;
}
export function backendSocketPath(run: string) {
  return join(run, `app-${randomBytes(8).toString("hex")}.sock`);
}
/** Only names created by backendSocketPath, inside the daemon's own run directory. */
export function backendSocket(run: string, name: unknown) {
  if (typeof name !== "string" || !BACKEND_SOCKET.test(name)) return;
  const path = join(run, name);
  try {
    const info = lstatSync(path);
    if (!info.isSocket() || (process.getuid && info.uid !== process.getuid()))
      return;
  } catch {
    return;
  }
  return path;
}

export const TunnelMode = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quick") }).strict(),
  z
    .object({
      kind: z.literal("named"),
      name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      origin: z.string().url(),
      config: z.string().max(4096).optional(),
    })
    .strict(),
]);
export type TunnelMode = z.infer<typeof TunnelMode>;
export const sameMode = (a: TunnelMode, b: TunnelMode) =>
  a.kind === b.kind &&
  (a.kind === "quick" ||
    (b.kind === "named" &&
      a.name === b.name &&
      a.origin === b.origin &&
      (a.config ?? "") === (b.config ?? "")));

const ConnectionRecord = z
  .object({
    schema: z.literal(1),
    protocol: z.number().int().positive(),
    version: z.string().max(100),
    instance: z.string().uuid(),
    pid: z.number().int().min(2),
    identity: z.string(),
    pidNamespace: z.string().optional(),
    control: z.string().max(4096),
    token: z.string().min(40).max(60),
    mode: TunnelMode,
    startedAt: z.number(),
  })
  .strict();
export type ConnectionRecord = z.infer<typeof ConnectionRecord>;

export type Hello = {
  protocol: number;
  version: string;
  instance: string;
  pid: number;
  startedAt: number;
  mode: TunnelMode;
  origin?: string;
  relay: { host: string; port: number };
  tunnel: {
    state: "starting" | "ready" | "reconnecting" | "stopped";
    pid?: number;
    identity?: string;
    since: number;
  };
  backend: {
    generation: number;
    state: "none" | "pending" | "ready";
    since: number;
  };
};

export function readConnectionRecord(dir: string) {
  let raw: string;
  try {
    raw = readFileSync(join(dir, CONNECTION_RECORD), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = ConnectionRecord.safeParse(
    (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    })(),
  );
  if (!parsed.success)
    throw new Error(
      `The connection service record ${join(dir, CONNECTION_RECORD)} is unreadable or from an unsupported release. Stop the process it names yourself, then remove the file; workspace data is unaffected.`,
    );
  return parsed.data;
}

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
/** One authenticated request on the connection service's private socket. */
export function connectionControl<T = any>(
  record: Pick<ConnectionRecord, "control" | "token">,
  operation: string,
  body: unknown = {},
  timeout = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: record.control,
        path: "/v1/" + operation,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + record.token,
        },
        timeout,
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          out += chunk;
          if (out.length > 100000) req.destroy();
        });
        res.on("end", () => {
          let value: any;
          try {
            value = JSON.parse(out);
          } catch {
            return reject(
              new ControlError("Invalid connection service response"),
            );
          }
          if (res.statusCode === 200) resolve(value);
          else
            reject(
              new ControlError(
                value?.error ?? "Connection service request failed",
                res.statusCode,
              ),
            );
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new ControlError("Connection service did not respond")),
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

export type Inspection =
  | { state: "absent" }
  | {
      state: "running";
      record: ConnectionRecord;
      hello: Hello;
      local: boolean;
    }
  | {
      state: "unresponsive" | "exited" | "unknown";
      record: ConnectionRecord;
      local: boolean;
    };
/**
 * Finds this workspace's connection service and confirms it through its
 * private socket. A record from another PID namespace (the Docker companion's
 * connection container) is used only through that socket, never signalled.
 */
export async function inspectConnection(dir: string): Promise<Inspection> {
  const record = readConnectionRecord(dir);
  if (!record) return { state: "absent" };
  const local = record.pidNamespace === pidNamespace();
  if (local) {
    const state = processState(record);
    if (state === "exited") return { state, record, local };
    if (state === "unknown") return { state, record, local };
  }
  try {
    const hello = await connectionControl<Hello>(record, "hello", {}, 3000);
    if (hello.instance !== record.instance)
      return { state: "unknown", record, local };
    return { state: "running", record, hello, local };
  } catch {
    return { state: "unresponsive", record, local };
  }
}

/** Status without control credentials or socket paths. */
export function publicConnection(found: Inspection) {
  if (found.state === "absent") return { state: "stopped" };
  const base = {
    state: found.state,
    pid: found.local ? found.record.pid : undefined,
    managedBy: found.local ? "this-computer" : "another-container",
    version: found.record.version,
    protocol: found.record.protocol,
    mode: found.record.mode.kind,
    startedAt: found.record.startedAt,
  };
  if (found.state !== "running") return base;
  const { hello } = found;
  return {
    ...base,
    url: hello.origin,
    relay: `http://${hello.relay.host}:${hello.relay.port}`,
    tunnel: {
      state: hello.tunnel.state,
      pid: found.local ? hello.tunnel.pid : undefined,
      since: hello.tunnel.since,
    },
    backend: hello.backend,
  };
}

export const probeProof = (
  lease: string,
  instance: string,
  generation: number,
  nonce: string,
) =>
  createHmac("sha256", lease)
    .update(`loop55-backend-probe\n${instance}\n${generation}\n${nonce}`)
    .digest("hex");

/**
 * The application's side of one launch: a generation-bound lease, a private
 * socket the service verifies before forwarding, and heartbeats carrying the
 * service's current public origin. A replaced service is re-registered.
 */
export class BackendLease {
  generation = 0;
  origin = "";
  private lease = "";
  private instance = "";
  private timer?: NodeJS.Timeout;
  private failing = false;
  private closed = false;
  private registered = false;
  readonly socket: string;
  onOrigin: (origin: string) => void = () => {};
  log: (message: string) => void = console.error;
  constructor(
    private dir: string,
    private record: ConnectionRecord,
  ) {
    this.socket = backendSocketPath(dirname(record.control));
  }
  /** Registered with a service that currently answers this launch's heartbeats. */
  get attached() {
    return this.registered && !this.failing && !this.closed;
  }
  /** Proof answered on the application socket; keyed by the unpublished lease. */
  probe = (nonce: string) =>
    probeProof(this.lease, this.instance, this.generation, nonce);
  async acquire(deadline = Date.now() + 120000) {
    for (;;) {
      try {
        const granted = await connectionControl(this.record, "lease");
        this.generation = granted.generation;
        this.lease = granted.lease;
        this.instance = granted.instance;
        this.registered = false;
        // A replacement service's Quick Tunnel has a new address: the gateway
        // adopts it before the launch registers for traffic.
        if (this.origin) this.applyOrigin(granted.origin);
        else this.origin = granted.origin;
        return granted.origin as string;
      } catch (error) {
        // 503: the tunnel has no confirmed address yet (reconnecting).
        if ((error as ControlError).status !== 503 || Date.now() > deadline)
          throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  async register() {
    const registered = await connectionControl(this.record, "register", {
      generation: this.generation,
      lease: this.lease,
      socket: basename(this.socket),
    });
    this.applyOrigin(registered.origin);
    this.registered = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.heartbeat(), 2000);
    this.timer.unref();
  }
  private applyOrigin(origin: unknown) {
    if (typeof origin !== "string" || !origin || origin === this.origin) return;
    this.origin = origin;
    this.onOrigin(origin);
  }
  private async heartbeat() {
    try {
      const beat = await connectionControl(this.record, "heartbeat", {
        generation: this.generation,
        lease: this.lease,
      });
      if (this.failing) this.log("Connection service reachable again.");
      this.failing = false;
      this.registered = beat.registered === true;
      this.applyOrigin(beat.origin);
      // The heartbeat loop keeps retrying a withdrawn socket. Only a
      // confirmed heartbeat or successful probe can mark it registered.
      if (!this.registered && !this.closed) {
        await this.register().then(
          () => this.log("Registered again after a stall."),
          // Keep detached; the next heartbeat will retry this same lease.
          () => {},
        );
      }
    } catch (error) {
      if (this.closed) return;
      if (!this.failing)
        this.log(
          (error as ControlError).status === 409
            ? "This application launch no longer owns the public address."
            : "Connection service unreachable; the public address is unavailable until it returns.",
        );
      this.failing = true;
      await this.reattach();
    }
  }
  /**
   * A restarted service (service manager or container) gets a fresh
   * registration. Retried on every failing heartbeat until a lease from that
   * service is held: a replacement answers before its tunnel has an address.
   * A newer launch's lease on the same service is never contested.
   */
  private async reattach() {
    const found = await inspectConnection(this.dir).catch(() => undefined);
    if (
      this.closed ||
      found?.state !== "running" ||
      found.record.instance === this.instance ||
      found.hello.protocol !== CONNECTION_PROTOCOL
    )
      return;
    try {
      this.record = found.record;
      await this.acquire(Date.now());
      await this.register();
      this.failing = false;
      this.log("Registered with the restarted connection service.");
    } catch {
      /* Retried on the next heartbeat. */
    }
  }
  async withdraw() {
    this.closed = true;
    clearInterval(this.timer);
    if (!this.lease) return;
    await connectionControl(this.record, "withdraw", {
      generation: this.generation,
      lease: this.lease,
    }).catch(() => {});
  }
}
