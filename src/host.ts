import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { chmod, readFile, rm, stat, unlink } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { linkedDockerWorkspaces, proxyLinkedDocker } from "./linked-docker.js";
import {
  agentSources,
  proxyAgentSource,
  connectAgentSourceEvents,
} from "./agent-sources.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  Command,
  validateAnswer,
  type AdapterEvent,
  type Receipt,
  type ServerMessage,
} from "./protocol.js";
import type { Adapter } from "./adapters/types.js";
import { State, secret, hash, atomic } from "./state.js";
import {
  cardAuthorization,
  cardReadRoute,
  type CardAuthorization,
} from "./shared/card-access.js";
import { Problem } from "./shared/problem.js";
import type { DeviceTrust, TrustedDevice } from "./device-trust.js";
import {
  fleetDeviceAuthorization,
  type FleetDeviceRequest,
} from "./fleet-device-authorization.js";

type Device = TrustedDevice;
const cleanDevice = ({ id, name, expires }: Device) => ({ id, name, expires });
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req: IncomingMessage) {
  if (req.headers["content-type"] !== "application/json")
    throw new Error("Expected application/json");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const b of req) {
    n += b.length;
    if (n > 100000) throw new Error("Request too large");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
const Pair = z
  .object({
    secret: z.string().min(40).max(60),
    name: z.string().trim().max(80).default("Phone"),
    credential: z.literal("cookie").default("cookie"),
    ceremonyId: z.string().uuid().optional(),
  })
  .strict();

export class Host {
  /** Optional workspace application. The legacy session protocol stays testable. */
  workspace?: {
    /** Experimental workspaces never discover or proxy the everyday Docker sources. */
    isolated?: boolean;
    http: (req: IncomingMessage, res: ServerResponse) => void;
    fleetAdminHttp?: (req: IncomingMessage, res: ServerResponse) => void;
    /** Dedicated machine protocol; never forwards to the browser workspace API. */
    peerHttp?: (req: IncomingMessage, res: ServerResponse) => void;
    authorizeCards?: (req: IncomingMessage) => CardAuthorization;
    status: () => unknown;
    admin: (action: string, input: any) => Promise<unknown>;
    shareTools?: (
      sourceId?: string,
      action?: "connect" | "disconnect",
    ) => Promise<unknown>;
    connect: (socket: WebSocket, url: URL) => () => void;
    originChanged: (origin: string) => void;
  };
  state: State;
  adapter!: Adapter;
  origin = "";
  port = 0;
  private devices = new Map<string, Device>();
  private pairs = new Map<string, number>();
  private attempts: number[] = [];
  private clients = new Map<WebSocket, string>();
  private decisions = new Set<string>();
  private promptPending = false;
  private stopped = false;
  private originGeneration = 0;
  private active = 0;
  private fleetRequests = new Map<
    ServerResponse,
    { req: IncomingMessage; deviceId: string }
  >();
  private socketPath?: string;
  private probe?: (nonce: string) => string;
  private adminToken = secret();
  private flush?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private publicServer = createServer((q, s) => void this.http(q, s));
  private adminServer = createServer((q, s) => void this.admin(q, s));
  private ws = new WebSocketServer({
    noServer: true,
    maxPayload: 100000,
    perMessageDeflate: false,
  });
  onStop: () => Promise<void> = async () => {};
  constructor(
    private dir: string,
    initial: ConstructorParameters<typeof State>[1],
    private readonly trust?: DeviceTrust,
  ) {
    this.state = new State(dir, initial);
    if (trust) return;
    try {
      const devices = z
        .array(
          z.object({
            id: z.string().uuid(),
            name: z.string().max(100),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            csrf: z.string(),
            expires: z.number().finite(),
            maxExpires: z.number().finite().optional(),
          }),
        )
        .max(10)
        .parse(JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")));
      for (const device of devices) {
        const maxExpires = device.maxExpires ?? device.expires;
        if (Math.min(device.expires, maxExpires) > Date.now())
          this.devices.set(device.id, {
            ...device,
            expires: Math.min(device.expires, maxExpires),
            maxExpires,
          });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Device trust store is unreadable. Restore devices.json or remove it to pair again.",
        );
    }
  }
  emit = (event: AdapterEvent) => {
    if (this.stopped) return;
    // The v1 session wire predates shared activities, and paired clients
    // validate frames against a closed union, so an unknown variant would be
    // rejected by older builds. Activities are persisted and served only by
    // the workspace (GET /conversations/:id/activities); the legacy snapshot
    // has no activity projection, so forwarding them could not be replayed
    // consistently either.
    if (
      event.type === "activity" ||
      event.type === "activity_capabilities" ||
      event.type === "usage"
    )
      return;
    let frame;
    try {
      frame = this.state.apply(event);
    } catch {
      frame = this.state.apply({
        type: "status",
        status: "failed",
        detail:
          "Native approval exceeds safe display bounds. Work was interrupted; review it in the native harness.",
      });
      void this.adapter?.cancel().catch(() => {});
    }
    for (const [socket, id] of this.clients) {
      const device = this.device(id);
      if (!device) socket.close(4003, "Device revoked");
      else this.send(socket, frame);
    }
    if (!this.flush)
      this.flush = setTimeout(() => {
        this.flush = undefined;
        this.state.save();
      }, 200);
  };
  private send(socket: WebSocket, m: ServerMessage) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) {
      socket.close(4008, "Reconnect for snapshot");
      return;
    }
    socket.send(JSON.stringify(m));
  }
  /**
   * Without options the public gateway takes a loopback TCP port. Behind the
   * connection service it listens on a private Unix socket instead and serves
   * no origin until setOrigin applies the service's confirmed address.
   */
  async listen(
    options: { socket?: string; probe?: (nonce: string) => string } = {},
  ) {
    this.publicServer.on("upgrade", (req, socket, head) => {
      const device = this.authenticate(req);
      if (
        !this.validOrigin(req) ||
        !device ||
        req.headers.authorization !== undefined ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        this.clients.size >= 256 ||
        [...this.clients.values()].filter((id) => id === device.id).length >= 32
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url || "", this.origin);
      } catch {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      const source = /^\/api\/agent-sources\/([^/]+)\/events\/ws$/.exec(
        url.pathname,
      );
      const local =
        url.pathname === "/ws" ||
        (!!this.workspace && url.pathname === "/api/events/ws");
      if (!local && !(source && this.workspace && !this.workspace.isolated)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.ws.handleUpgrade(req, socket, head, (ws) => {
        this.clients.set(ws, device.id);
        const cleanup = local ? this.workspace?.connect(ws, url) : undefined;
        if (source) {
          try {
            void connectAgentSourceEvents(
              ws,
              decodeURIComponent(source[1]),
              url.searchParams,
            ).catch(() =>
              ws.close(1013, "Execution source updates unavailable"),
            );
          } catch {
            ws.close(1008, "Invalid execution source");
          }
        }
        const cursor = Number(url.searchParams.get("cursor"));
        const events = Number.isSafeInteger(cursor)
          ? this.state.replay(url.searchParams.get("epoch") ?? "", cursor)
          : undefined;
        // No await here: subscribe and snapshot/replay share one event-loop turn.
        if (this.workspace) {
          // Workspace streams have their own durable cursor and snapshot contract.
        } else if (events) {
          for (const event of events) this.send(ws, event);
          for (const { id, status, message } of this.state.receipts.values())
            this.send(ws, { v: 1, receipt: { id, status, message } });
        } else
          this.send(ws, {
            v: 1,
            snapshot: this.state.snapshot,
            receipts: [...this.state.receipts.values()].map(
              ({ id, status, message }) => ({ id, status, message }),
            ),
          });
        let alive = true;
        ws.on("pong", () => {
          alive = true;
        });
        const ping = setInterval(() => {
          if (!alive) ws.terminate();
          else {
            alive = false;
            ws.ping();
          }
        }, 25000);
        ws.on("close", () => {
          cleanup?.();
          clearInterval(ping);
          this.clients.delete(ws);
        });
        ws.on("error", () => {});
        ws.on("message", (data) => {
          if (!this.workspace)
            void this.command(ws, device.id, data.toString());
        });
      });
    });
    this.publicServer.requestTimeout = 10000;
    this.publicServer.headersTimeout = 10000;
    if (options.socket) {
      this.socketPath = options.socket;
      this.probe = options.probe;
      await rm(options.socket, { force: true });
      await new Promise<void>((resolve, reject) => {
        this.publicServer.once("error", reject);
        this.publicServer.listen(options.socket, resolve);
      });
      await chmod(options.socket, 0o600);
    } else {
      await new Promise<void>((resolve) =>
        this.publicServer.listen(0, "127.0.0.1", resolve),
      );
      this.port = (this.publicServer.address() as { port: number }).port;
      this.origin = `http://127.0.0.1:${this.port}`;
      this.workspace?.originChanged(this.origin);
    }
    await new Promise<void>((resolve, reject) => {
      this.adminServer.once("error", reject);
      this.adminServer.listen(0, "127.0.0.1", resolve);
    });
    atomic(join(this.dir, "control.json"), {
      port: (this.adminServer.address() as { port: number }).port,
      token: this.adminToken,
      pid: process.pid,
    });
    this.heartbeat = setInterval(() => {
      this.trust?.expire();
      for (const [socket, id] of this.clients) {
        const device = this.device(id);
        if (!device) socket.close(4003, "Device revoked");
      }
      for (const d of this.devices.values())
        if (d.expires <= Date.now()) this.revoke(d.id);
    }, 30000);
  }
  setOrigin(origin: string) {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Public origin must be a bare HTTPS origin.");
    if (this.origin !== url.origin) {
      this.originGeneration++;
      this.closeFleetRequests();
    }
    this.origin = url.origin;
    this.workspace?.originChanged(this.origin);
    // Device trust belongs to this workspace. Changing transport invalidates
    // unused pairing links and old sockets, but never grants trust to a new device.
    this.pairs.clear();
    this.trust?.originChanged(this.origin);
    for (const socket of this.clients.keys())
      socket.close(1012, "Gateway address changed");
  }
  pair() {
    if (this.trust) return this.trust.pair(this.origin);
    const token = secret();
    this.pairs.clear();
    this.pairs.set(hash(token), Date.now() + 120000);
    return { url: `${this.origin}/#pair=${token}`, expiresIn: 120 };
  }
  status() {
    if (this.workspace)
      return {
        ...(this.workspace.status() as object),
        url: this.origin,
        devices: this.deviceList().map(cleanDevice),
        pid: process.pid,
      };
    const s = this.state.snapshot;
    return {
      harness: s.harness,
      version: s.version,
      project: s.project,
      session: s.session,
      nativeSession: s.nativeSession,
      state: s.status,
      billing: s.billing,
      url: this.origin,
      devices: this.deviceList().map(cleanDevice),
      pid: process.pid,
    };
  }
  private revoke(id: string) {
    if (this.trust) this.trust.revoke(id);
    else this.devices.delete(id);
    for (const [s, d] of this.clients)
      if (d === id) s.close(4003, "Device revoked");
    this.closeFleetRequests(id);
    if (!this.trust) this.saveDevices();
  }
  private closeFleetRequests(deviceId?: string) {
    for (const [res, request] of this.fleetRequests) {
      if (deviceId && request.deviceId !== deviceId) continue;
      const authorization = (request.req as FleetDeviceRequest)[
        fleetDeviceAuthorization
      ];
      if (authorization) authorization.active = false;
      this.fleetRequests.delete(res);
      res.destroy();
      request.req.destroy();
    }
  }
  private deviceList() {
    return this.trust ? this.trust.devices() : [...this.devices.values()];
  }
  private device(id: string) {
    // The delegated store owns both expiry observation and durable retirement.
    // A second clock read here or in callers could escape its recovery guard.
    if (this.trust) return this.trust.device(id);
    const device = this.devices.get(id);
    return device && device.expires > Date.now() ? device : undefined;
  }
  private saveDevices() {
    atomic(join(this.dir, "devices.json"), [...this.devices.values()]);
  }
  private validHost(req: IncomingMessage) {
    return !!this.origin && req.headers.host === new URL(this.origin).host;
  }
  private validOrigin(req: IncomingMessage) {
    return this.validHost(req) && req.headers.origin === this.origin;
  }
  private get cookieName() {
    const name = this.origin.startsWith("https:")
      ? "__Host-loop"
      : "loop_local";
    // Cookies ignore ports. Preview identities stay distinct across local hosts and rebuilds.
    return this.workspace?.isolated
      ? `${name}_${hash(resolve(this.dir)).slice(0, 24)}`
      : name;
  }
  private cookie(token: string, expires: number) {
    const secure = this.origin.startsWith("https:");
    const age = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    return `${this.cookieName}=${token}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${age}`;
  }
  private authenticate(req: IncomingMessage) {
    const token = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(this.cookieName + "="))
      ?.slice(this.cookieName.length + 1);
    if (!token || token.length > 100) return;
    if (this.trust) return this.trust.authenticate(hash(token));
    const device = [...this.devices.values()].find(
      (d) => equal(d.hash, hash(token)) && d.expires > Date.now(),
    );
    if (device && device.expires < Date.now() + 364 * 86400000) {
      device.expires = Math.min(device.maxExpires, Date.now() + 365 * 86400000);
      this.saveDevices();
    }
    return device;
  }
  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  private async http(req: IncomingMessage, res: ServerResponse) {
    this.active++;
    res.once("close", () => this.active--);
    // Registration check from the connection service over the private socket.
    // The relay never forwards /__loop paths from the public listener.
    if (this.probe && req.url?.startsWith("/__loop/backend-probe?")) {
      const nonce = new URL(req.url, "http://probe").searchParams.get("nonce");
      if (req.method !== "GET" || !nonce || !/^[\w-]{16,100}$/.test(nonce))
        return this.json(res, 400, { error: "Invalid probe" });
      return this.json(res, 200, { proof: this.probe(nonce) });
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (!this.validHost(req))
      return this.json(res, 403, { error: "Unrecognized host." });
    try {
      if (req.url?.startsWith("/api/fleet/peer/")) {
        if (this.workspace?.isolated || !this.workspace?.peerHttp)
          return this.json(res, 404, {
            error: "Fleet enrollment unavailable.",
          });
        this.workspace.peerHttp(req, res);
        return;
      }
      // Select bearer authentication before cookies or URL normalization. This
      // exception can only forward the three implemented card read routes.
      if (this.workspace && req.headers.authorization !== undefined) {
        if (
          !cardReadRoute(req.method, req.url) ||
          !this.workspace.authorizeCards ||
          req.headers["x-http-method-override"] !== undefined ||
          req.headers["x-method-override"] !== undefined
        )
          return this.json(res, 403, {
            error: "Card credentials permit card reads only.",
          });
        if (
          (req.headers.origin && !this.validOrigin(req)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return this.json(res, 403, { error: "Origin rejected." });
        try {
          (
            req as IncomingMessage & { [cardAuthorization]?: CardAuthorization }
          )[cardAuthorization] = this.workspace.authorizeCards(req);
        } catch (error) {
          const status = error instanceof Problem ? error.status : 500;
          if (status === 429) res.setHeader("Retry-After", "60");
          return this.json(res, status, {
            error:
              error instanceof Problem
                ? error.message
                : "Card authorization unavailable.",
          });
        }
        this.workspace.http(req, res);
        return;
      }
      const path = new URL(req.url!, this.origin).pathname;
      if (path === "/pair" && req.method === "POST") {
        this.attempts = this.attempts.filter((t) => Date.now() - t < 60000);
        if (this.attempts.length >= 20)
          return this.json(res, 429, {
            error: "Too many pairing attempts. Try in one minute.",
          });
        this.attempts.push(Date.now());
        const input = Pair.parse(await body(req));
        if (!this.validOrigin(req))
          return this.json(res, 403, { error: "Origin rejected." });
        if (this.trust) {
          try {
            const { token, expires } = this.trust.redeem(
              {
                secret: input.secret,
                name: input.name,
                ceremonyId: input.ceremonyId,
              },
              this.origin,
            );
            res.setHeader("Set-Cookie", this.cookie(token, expires));
            return this.json(res, 200, { paired: true });
          } catch (error) {
            if (error instanceof Problem)
              return this.json(res, error.status, { error: error.message });
            throw error;
          }
        }
        const digest = hash(input.secret);
        const expiry = this.pairs.get(digest);
        if (!expiry || expiry <= Date.now())
          return this.json(res, 403, {
            error:
              "Pairing link expired, invalid or already used. Run loop pair on your desktop.",
          });
        this.pairs.delete(digest); // Single-use consume and credential creation happen without awaiting.
        if (this.devices.size >= 10)
          return this.json(res, 409, {
            error: "Device limit reached. Revoke a device on the desktop.",
          });
        const token = secret();
        const device = {
          id: randomUUID(),
          name: input.name || "Phone",
          hash: hash(token),
          csrf: secret(),
          expires: Date.now() + 365 * 86400000,
          maxExpires: Date.now() + 2 * 365 * 86400000,
        };
        this.devices.set(device.id, device);
        this.saveDevices();
        res.setHeader("Set-Cookie", this.cookie(token, device.expires));
        return this.json(res, 200, { paired: true });
      }
      if (path === "/session" && req.method === "GET") {
        const device = this.authenticate(req);
        if (!device)
          return this.json(res, 401, {
            error: "Pair this device from the desktop.",
          });
        return this.json(res, 200, {
          csrf: device.csrf,
          device: cleanDevice(device),
        });
      }
      if (
        this.workspace &&
        path === "/api/capabilities" &&
        req.method === "GET"
      ) {
        this.workspace.http(req, res);
        return;
      }
      if (this.workspace && path.startsWith("/api/")) {
        const device = this.authenticate(req);
        if (!device)
          return this.json(
            res,
            path === "/api/auth/get-session" ? 200 : 401,
            path === "/api/auth/get-session"
              ? null
              : { error: "Pair this device from the desktop." },
          );
        if (
          !["GET", "HEAD"].includes(req.method || "") &&
          (!this.validOrigin(req) ||
            !equal(String(req.headers["x-loop-csrf"] || ""), device.csrf))
        )
          return this.json(res, 403, {
            error: "Workspace authorization rejected.",
          });
        if (path === "/api/auth/sign-out" && req.method === "POST") {
          this.revoke(device.id);
          return this.json(res, 200, { ok: true });
        }
        if (path.startsWith("/api/fleet/admin/")) {
          if (this.workspace.isolated || !this.workspace.fleetAdminHttp)
            return this.json(res, 404, {
              error: "Fleet administration unavailable.",
            });
          if (
            (req.headers.origin && !this.validOrigin(req)) ||
            req.headers["sec-fetch-site"] === "cross-site" ||
            req.headers["x-http-method-override"] !== undefined ||
            req.headers["x-method-override"] !== undefined
          )
            return this.json(res, 403, {
              error: "Fleet administration authorization rejected.",
            });
          const generation = this.originGeneration;
          const authorization = {
            deviceId: device.id,
            active: true,
            current: () =>
              !this.stopped && generation === this.originGeneration,
          };
          (req as FleetDeviceRequest)[fleetDeviceAuthorization] = authorization;
          this.fleetRequests.set(res, { req, deviceId: device.id });
          const done = () => {
            authorization.active = false;
            this.fleetRequests.delete(res);
          };
          res.once("finish", done);
          res.once("close", done);
          this.workspace.fleetAdminHttp(req, res);
          return;
        }
        if (this.workspace.isolated) {
          if (
            [
              "/api/linked-workspaces",
              "/api/agent-sources",
              "/api/mcp-sharing",
            ].includes(path) &&
            req.method === "GET"
          )
            return this.json(res, 200, []);
          if (
            path.startsWith("/api/agent-sources/") ||
            path.startsWith("/api/linked/") ||
            path === "/api/mcp-sharing"
          )
            return this.json(res, 403, {
              error: "Previews do not connect to other Loop workspaces.",
            });
        }
        if (path === "/api/linked-workspaces" && req.method === "GET") {
          const workspaces = await linkedDockerWorkspaces();
          return this.json(
            res,
            200,
            workspaces.map(({ id, name }) => ({ id, name })),
          );
        }
        if (path === "/api/agent-sources" && req.method === "GET")
          return this.json(res, 200, await agentSources());
        if (path === "/api/mcp-sharing" && req.method === "GET") {
          if (!this.workspace.shareTools)
            return this.json(res, 404, { error: "Tool sharing unavailable" });
          return this.json(res, 200, await this.workspace.shareTools());
        }
        if (path === "/api/mcp-sharing" && req.method === "POST") {
          if (!this.workspace.shareTools)
            return this.json(res, 404, { error: "Tool sharing unavailable" });
          const input = await body(req);
          if (
            typeof input.sourceId !== "string" ||
            !["connect", "disconnect"].includes(input.action)
          )
            return this.json(res, 400, { error: "Choose an execution source" });
          return this.json(
            res,
            200,
            await this.workspace.shareTools(input.sourceId, input.action),
          );
        }
        if (path.startsWith("/api/agent-sources/")) {
          const match = /^\/api\/agent-sources\/([^/]+)\/(.+)$/.exec(path);
          if (!match) return this.json(res, 404, { error: "Not found" });
          const query = new URL(req.url!, this.origin).search;
          await proxyAgentSource(
            req,
            res,
            decodeURIComponent(match[1]),
            match[2] + query,
          );
          return;
        }
        if (path.startsWith("/api/linked/")) {
          const match = /^\/api\/linked\/([a-f0-9]{64})\/(.+)$/.exec(path);
          if (!match) return this.json(res, 404, { error: "Not found" });
          const query = new URL(req.url!, this.origin).search;
          await proxyLinkedDocker(req, res, match[1], match[2] + query);
          return;
        }
        if (path === "/api/workspace/devices" && req.method === "GET")
          return this.json(res, 200, this.deviceList().map(cleanDevice));
        if (path === "/api/workspace/revoke" && req.method === "POST") {
          const input = await body(req);
          this.revoke(String(input.id));
          return this.json(res, 200, { ok: true });
        }
        this.workspace.http(req, res);
        return;
      }
      if (
        req.method !== "GET" ||
        (!this.workspace &&
          ![
            "/",
            "/app.js",
            "/app.css",
            "/manifest.webmanifest",
            "/icon.svg",
            "/icon-192.png",
            "/icon-512.png",
            "/apple-touch-icon.png",
            "/sw.js",
          ].includes(path))
      )
        return this.json(res, 404, { error: "Not found" });
      const root = fileURLToPath(new URL("./web/", import.meta.url));
      // Older paired tabs still request the original avatar URLs after upgrades.
      const assetPath = decodeURIComponent(path).replace(
        /^\/avatars\/([a-z]+)\.webp$/,
        "/avatars/robots/$1.webp",
      );
      const asset = resolve(
        root,
        assetPath === "/" ? "index.html" : "." + assetPath,
      );
      if (!asset.startsWith(root.endsWith(sep) ? root : root + sep))
        return this.json(res, 404, { error: "Not found" });
      const info = await stat(asset);
      if (!info.isFile() || info.size > 20 * 1024 * 1024)
        throw new Error("Asset unavailable");
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webp": "image/webp",
        ".webmanifest": "application/manifest+json",
      };
      res.setHeader(
        "Content-Type",
        types[extname(asset)] ?? "application/octet-stream",
      );
      res.end(await readFile(asset));
    } catch {
      if (!res.headersSent)
        this.json(res, 400, { error: "Invalid request or unavailable asset." });
      else res.end();
    }
  }
  private async command(socket: WebSocket, deviceId: string, raw: string) {
    let c: Command | undefined;
    try {
      const envelope = z
        .object({ csrf: z.string().max(100), command: Command })
        .strict()
        .parse(JSON.parse(raw));
      c = envelope.command;
      const device = this.device(deviceId);
      if (!device || !equal(device.csrf, envelope.csrf))
        throw new Error("Device authorization expired.");
      if (c.session !== this.state.snapshot.session)
        throw new Error("Wrong session.");
      const digest = hash(JSON.stringify(c));
      const prior = this.state.receipts.get(c.id);
      if (prior) {
        if (prior.digest !== digest) throw new Error("Command ID conflict.");
        this.send(socket, {
          v: 1,
          receipt: {
            id: prior.id,
            status: prior.status,
            message: prior.message,
          },
        });
        return;
      }
      // Validate before accepting; rejected input cannot reserve an unrelated approval.
      if (
        c.type === "prompt" &&
        (this.promptPending ||
          !(
            ["ready", "completed", "interrupted"].includes(
              this.state.snapshot.status,
            ) ||
            (this.state.snapshot.status === "failed" &&
              this.state.snapshot.recoverable)
          ))
      )
        throw new Error("Wait for the current turn to finish.");
      if (c.type === "answer") {
        const requestId = c.request;
        const request = this.state.snapshot.requests.find(
          (r) => r.id === requestId,
        );
        if (!request || this.decisions.has(c.request))
          throw new Error("Request already answered or expired.");
        validateAnswer(request, c.answer);
      }
      if (
        c.type === "cancel" &&
        !["running", "awaiting-input"].includes(this.state.snapshot.status)
      )
        throw new Error("No active turn to interrupt.");
      this.state.begin(c.id, digest);
    } catch (e) {
      const message =
        e instanceof Error ? e.message.slice(0, 500) : "Invalid command";
      if (c)
        this.send(socket, {
          v: 1,
          receipt: { id: c.id, status: "rejected", message },
        });
      else this.send(socket, { v: 1, error: message });
      return;
    }
    if (!c) return;
    let receipt: Receipt;
    try {
      if (c.type === "prompt") {
        this.promptPending = true;
        this.emit({
          type: "item",
          item: { id: c.id, kind: "user", text: c.text },
        });
        this.emit({ type: "status", status: "running" });
        await this.adapter.prompt(c.text);
      } else if (c.type === "cancel") await this.adapter.cancel();
      else {
        this.decisions.add(c.request);
        await this.adapter.answer(c.request, c.answer);
      }
      receipt = this.state.receipt(c.id, "accepted");
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message.slice(0, 1000)
          : "Native outcome unknown";
      receipt = this.state.receipt(c.id, "unknown", message);
      this.emit({
        type: "error",
        message: `Outcome unknown: ${message}. Do not resend automatically.`,
      });
    } finally {
      if (c.type === "prompt") this.promptPending = false;
      // An uncertain approval stays reserved: it must not authorize a second action.
    }
    for (const ws of this.clients.keys()) this.send(ws, { v: 1, receipt });
  }
  private async admin(req: IncomingMessage, res: ServerResponse) {
    try {
      if (
        req.headers.origin ||
        !equal(req.headers.authorization ?? "", "Bearer " + this.adminToken)
      )
        return this.json(res, 403, {
          error: "Local control authentication required",
        });
      if (req.method !== "POST") return this.json(res, 405, {});
      const input = await body(req);
      switch (req.url) {
        case "/status":
          return this.json(res, 200, this.status());
        case "/pair":
          return this.json(res, 200, this.pair());
        case "/devices":
          return this.json(res, 200, this.deviceList().map(cleanDevice));
        case "/revoke":
          // Revocation is idempotent and must remain possible even when an
          // expiry/clock failure prevents this device from authenticating.
          if (typeof input.id !== "string" || !input.id)
            throw new Error("Unknown device");
          this.revoke(input.id);
          return this.json(res, 200, { revoked: true });
        case "/stop":
          this.json(res, 200, { stopping: true });
          void this.onStop();
          return;
        default:
          if (this.workspace)
            return this.json(
              res,
              200,
              await this.workspace.admin(req.url || "", input),
            );
          return this.json(res, 404, {});
      }
    } catch {
      this.json(res, 400, { error: "Invalid control request" });
    }
  }
  async close() {
    if (this.stopped) return;
    this.emit({ type: "status", status: "stopped" });
    this.stopped = true;
    this.closeFleetRequests();
    clearTimeout(this.flush);
    clearInterval(this.heartbeat);
    this.state.save();
    for (const s of this.clients.keys()) s.terminate();
    this.ws.close();
    if (this.socketPath) {
      // Behind the relay, let admitted requests finish for a bounded time so
      // a restart rarely leaves an outcome uncertain.
      this.publicServer.close();
      this.publicServer.closeIdleConnections();
      const end = Date.now() + 3000;
      while (this.active > 0 && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
    }
    this.publicServer.closeAllConnections();
    this.adminServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => this.publicServer.close(() => r())),
      new Promise<void>((r) => this.adminServer.close(() => r())),
    ]);
    await unlink(join(this.dir, "control.json")).catch(() => {});
    if (this.socketPath) await rm(this.socketPath, { force: true });
  }
}
