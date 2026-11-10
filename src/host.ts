import { PROCESS_FILES } from "./process-records.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import { chmod, readFile, rm, stat, unlink } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKEND_PROBE,
  equalSecret as equal,
  readJsonBody as body,
  jsonReply,
  problemReply,
  jsonServer,
} from "./local-control.js";
import { AgentSources } from "./agent-sources.js";
import type { EventSocket } from "./event-socket.js";
import { WorkspaceMultiplex } from "./server/workspace-multiplex.js";
import { WORKSPACE_MULTIPLEX_PATH } from "./shared/workspace-multiplex.js";
import type { FleetCapacity } from "./server/fleet-capacity.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { secret, hash, atomic, privateDir } from "./state.js";
import {
  cardAuthorization,
  type CardAuthorization,
} from "./shared/card-access.js";
import { Problem } from "./shared/problem.js";
import type { DeviceTrust, TrustedDevice } from "./device-trust.js";
import {
  fleetDeviceAuthorization,
  type FleetDeviceRequest,
} from "./fleet-device-authorization.js";
import { workspaceApi } from "./shared/workspace-api.js";
import { assetCacheControl, compressResponse } from "./http-transfer.js";

// The compiled client next to this module; when run from source (fixtures),
// the build's copy, as the server entry does.
const compiledWeb = fileURLToPath(new URL("./web/", import.meta.url));
const webRoot = existsSync(compiledWeb + "index.html")
  ? compiledWeb
  : fileURLToPath(new URL("../dist/web/", import.meta.url));

// The paired Node HTTP host consumes the same contracts as the Express app.
// This exact dispatch table is also included in the production route inventory.
export const pairedHostRoutes = [
  workspaceApi.agentSources,
  workspaceApi.workspaceDevices,
  workspaceApi.workspaceRevoke,
] as const;

type Device = TrustedDevice;
const cleanDevice = ({ id, name, expires }: Device) => ({ id, name, expires });
const Pair = z
  .object({
    secret: z.string().min(40).max(60),
    name: z.string().trim().max(80).default("Phone"),
    ceremonyId: z.string().uuid().optional(),
  })
  .strict();

export class Host {
  /** The workspace application must be installed before listening. */
  workspace!: {
    /** Experimental workspaces never discover or proxy the everyday Docker sources. */
    isolated?: boolean;
    http: (req: IncomingMessage, res: ServerResponse) => void;
    fleetAdminHttp?: (req: IncomingMessage, res: ServerResponse) => void;
    fleetCommandsHttp?: (req: IncomingMessage, res: ServerResponse) => void;
    /** Dedicated machine protocol; never forwards to the browser workspace API. */
    peerHttp?: (req: IncomingMessage, res: ServerResponse) => void;
    peerUpgrade?: (
      req: IncomingMessage,
      socket: import("node:stream").Duplex,
      head: Buffer,
      admit: () => boolean,
    ) => void;
    sources?: AgentSources;
    /** Shared with this companion's inbound peers and outbound transports. */
    fleetCapacity?: FleetCapacity;
    authorizeToken?: (req: IncomingMessage) => CardAuthorization;
    tokenEvents?: {
      upgrade: (
        req: IncomingMessage,
        socket: import("node:stream").Duplex,
        head: Buffer,
        admit: () => boolean,
      ) => void;
      close: () => void;
    };
    status: () => unknown;
    admin: (action: string, input: any) => Promise<unknown>;
    connect: (socket: EventSocket, url: URL) => () => void;
    originChanged: (origin: string) => void;
  };
  origin = "";
  port = 0;
  private attempts: number[] = [];
  private clients = new Map<WebSocket, string>();
  private stopped = false;
  private readonly sources = new AgentSources();
  private multiplex?: WorkspaceMultiplex;
  private agentSources() {
    return this.workspace.isolated
      ? this.sources
      : (this.workspace.sources ?? this.sources);
  }
  private originGeneration = 0;
  private active = 0;
  private publicRequests = 0;
  private fleetRequests = new Map<
    ServerResponse,
    { req: IncomingMessage; deviceId: string }
  >();
  private socketPath?: string;
  private probe?: (nonce: string) => string;
  private adminToken = secret();
  private heartbeat?: NodeJS.Timeout;
  private publicServer = createServer((q, s) =>
    compressResponse(q, s, () => void this.http(q, s)),
  );
  private adminServer = createServer((q, s) => void this.admin(q, s));
  private ws = new WebSocketServer({
    noServer: true,
    maxPayload: 100000,
    perMessageDeflate: false,
  });
  onStop: () => Promise<void> = async () => {};
  constructor(
    private dir: string,
    private readonly trust: DeviceTrust,
  ) {
    privateDir(dir);
  }
  /**
   * Without options the public gateway takes a loopback TCP port. Behind the
   * connection service it listens on a private Unix socket instead and serves
   * no origin until setOrigin applies the service's confirmed address.
   */
  async listen(
    options: { socket?: string; probe?: (nonce: string) => string } = {},
  ) {
    if (!this.workspace)
      throw new Error("A workspace application is required.");
    this.publicServer.on("upgrade", (req, socket, head) => {
      socket.on("error", () => socket.destroy());
      if (req.url?.startsWith("/api/fleet/peer/")) {
        if (
          !this.validHost(req) ||
          this.workspace.isolated ||
          !this.workspace.peerUpgrade
        ) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        this.workspace.peerUpgrade(req, socket, head, () =>
          this.admitSocket(socket, "peer"),
        );
        return;
      }
      // Token sockets are a separate, contract-admitted channel. Browser/device
      // cookies never substitute for a bearer, and linked-source paths stay out.
      if (
        req.url?.split("?")[0] ===
          "/api" + workspaceApi.channels.tokenEvents.path &&
        this.workspace.tokenEvents
      ) {
        if (
          !this.validHost(req) ||
          (req.headers.origin && !this.validOrigin(req)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        ) {
          socket.end(
            "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
          return;
        }
        // The owning handler validates the bearer before spending shared
        // connection tokens. Cookies never substitute for that authentication.
        return this.workspace.tokenEvents.upgrade(req, socket, head, () =>
          this.admitSocket(socket, "browser"),
        );
      }
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
      const multiplex =
        url.pathname === WORKSPACE_MULTIPLEX_PATH && !url.search;
      const local =
        url.pathname === workspaceApi.channels.events.pairedPath ||
        url.pathname === "/api" + workspaceApi.channels.events.path;
      if (!local && !multiplex && !(source && !this.workspace.isolated)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (!this.admitSocket(socket, "browser")) return;
      this.ws.handleUpgrade(req, socket, head, (ws) => {
        this.clients.set(ws, device.id);
        if (multiplex && !this.multiplex)
          this.multiplex = new WorkspaceMultiplex(
            (logical, id, query) => {
              if (!id)
                return this.workspace.connect(
                  logical,
                  new URL("/api/events/ws?" + query, this.origin),
                );
              if (this.workspace.isolated)
                throw new Error("Preview sources are isolated");
              return this.agentSources().events(logical, id, query);
            },
            (id) => {
              if (!id) return "local";
              if (this.workspace.isolated)
                throw new Error("Preview sources are isolated");
              return this.agentSources().current(id);
            },
          );
        const cleanup = multiplex
          ? this.multiplex!.connect(ws)
          : local
            ? this.workspace.connect(ws, url)
            : undefined;
        if (source) {
          try {
            void this.agentSources()
              .events(ws, decodeURIComponent(source[1]), url.searchParams)
              .catch(() =>
                ws.close(1013, "Execution source updates unavailable"),
              );
          } catch {
            ws.close(1008, "Invalid execution source");
          }
        }
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
      this.workspace.originChanged(this.origin);
    }
    await new Promise<void>((resolve, reject) => {
      this.adminServer.once("error", reject);
      this.adminServer.listen(0, "127.0.0.1", resolve);
    });
    atomic(join(this.dir, PROCESS_FILES.control), {
      port: (this.adminServer.address() as { port: number }).port,
      token: this.adminToken,
    });
    this.heartbeat = setInterval(() => {
      this.trust.expire();
      for (const [socket, id] of this.clients) {
        const device = this.device(id);
        if (!device) socket.close(4003, "Device revoked");
      }
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
    this.workspace.originChanged(this.origin);
    // Device trust belongs to this workspace. Changing transport invalidates
    // unused pairing links and old sockets, but never grants trust to a new device.
    this.trust.originChanged(this.origin);
    for (const socket of this.clients.keys())
      socket.close(1012, "Gateway address changed");
  }
  pair() {
    return this.trust.pair(this.origin);
  }
  status() {
    return {
      ...(this.workspace.status() as object),
      url: this.origin,
      devices: this.deviceList().map(cleanDevice),
      pid: process.pid,
    };
  }
  private revoke(id: string) {
    this.trust.revoke(id);
    for (const [s, d] of this.clients)
      if (d === id) s.close(4003, "Device revoked");
    this.closeFleetRequests(id);
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
  private delegateFleetRequest(
    req: IncomingMessage,
    res: ServerResponse,
    device: Device,
  ) {
    const generation = this.originGeneration;
    const authorization = {
      deviceId: device.id,
      active: true,
      current: () =>
        !this.stopped &&
        generation === this.originGeneration &&
        !!this.device(device.id),
    };
    (req as FleetDeviceRequest)[fleetDeviceAuthorization] = authorization;
    this.fleetRequests.set(res, { req, deviceId: device.id });
    const done = () => {
      authorization.active = false;
      this.fleetRequests.delete(res);
    };
    res.once("finish", done);
    res.once("close", done);
    return () => {
      if (!authorization.active || !authorization.current())
        throw new Problem(403, "This device can no longer access the source.");
    };
  }
  private deviceList() {
    return this.trust.devices();
  }
  private device(id: string) {
    return this.trust.device(id);
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
    return this.workspace.isolated
      ? `${name}_${hash(resolve(this.dir)).slice(0, 24)}`
      : name;
  }
  private cookie(token: string, expires: number, name = this.cookieName) {
    const secure = this.origin.startsWith("https:");
    const age = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    return `${name}=${token}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${age}`;
  }
  private authenticate(req: IncomingMessage) {
    const cookies = req.headers.cookie?.split(";").map((x) => x.trim()) ?? [];
    const value = cookies.find((x) => x.startsWith(this.cookieName + "="));
    const token = value?.slice(value.indexOf("=") + 1);
    if (!token || token.length > 100) return;
    return this.trust.authenticate(hash(token));
  }

  private json = jsonReply;
  private admitSocket(
    socket: import("node:stream").Duplex,
    kind: "browser" | "peer",
  ) {
    const capacity = this.workspace.fleetCapacity;
    if (!capacity) return true;
    const release = capacity.connection(kind)
      ? capacity.acquire(kind)
      : undefined;
    if (!release) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n",
      );
      return false;
    }
    // Keep the slot from authenticated admission through socket closure,
    // including an invalid or aborted WebSocket handshake.
    socket.once("close", release);
    return true;
  }
  private admitHttp(res: ServerResponse, kind: "browser" | "peer") {
    const capacity = this.workspace.fleetCapacity;
    if (!capacity) return true;
    const release = capacity.acquire(kind);
    if (kind === "peer")
      res.setHeader(
        "X-Loop-Fleet-Available",
        String(capacity.availablePeers()),
      );
    if (!release) {
      res.setHeader("Retry-After", "1");
      this.json(res, 503, {
        error: "This gateway is busy. Retry after capacity is available.",
      });
      return false;
    }
    res.once("finish", release);
    res.once("close", release);
    return true;
  }
  private admitPublic(req: IncomingMessage, res: ServerResponse) {
    if (!this.workspace.fleetCapacity?.snapshot().enabled) return true;
    // Public assets, pairing and capabilities cannot borrow authenticated
    // capacity. Keep their separate allowance below the remaining tunnel margin.
    if (this.publicRequests >= 16) {
      res.setHeader("Retry-After", "1");
      this.json(res, 503, {
        error: "Public requests are busy. Try again shortly.",
      });
      return false;
    }
    this.publicRequests++;
    const timer = setTimeout(() => {
      res.destroy();
      req.destroy();
    }, 15_000);
    timer.unref();
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.publicRequests--;
    };
    res.once("finish", release);
    res.once("close", release);
    return true;
  }
  private async http(req: IncomingMessage, res: ServerResponse) {
    this.active++;
    res.once("close", () => this.active--);
    // Registration check from the connection service over the private socket.
    // The relay never forwards /__loop paths from the public listener.
    if (this.probe && req.url?.startsWith(BACKEND_PROBE.path + "?")) {
      const nonce = new URL(req.url!, "http://probe").searchParams.get("nonce");
      if (req.method !== "GET" || !nonce || !/^[\w-]{16,100}$/.test(nonce))
        return this.json(res, 400, { error: "Invalid probe" });
      return this.json(res, 200, { proof: this.probe(nonce) });
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (!this.validHost(req))
      return this.json(res, 403, { error: "Unrecognized host." });
    try {
      // Select bearer authentication before cookies or URL normalization. This
      // application callback resolves the actual mounted contract before forwarding.
      if (req.headers.authorization !== undefined) {
        if (
          !this.workspace.authorizeToken ||
          req.headers["x-http-method-override"] !== undefined ||
          req.headers["x-method-override"] !== undefined
        )
          return this.json(res, 403, {
            error: "Integration credentials permit declared token routes only.",
          });
        if (
          (req.headers.origin && !this.validOrigin(req)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return this.json(res, 403, { error: "Origin rejected." });
        try {
          (
            req as IncomingMessage & { [cardAuthorization]?: CardAuthorization }
          )[cardAuthorization] = this.workspace.authorizeToken(req);
        } catch (error) {
          const status = error instanceof Problem ? error.status : 500;
          if (status === 429) res.setHeader("Retry-After", "60");
          return this.json(res, status, {
            error:
              error instanceof Problem
                ? error.message
                : "Integration authorization unavailable.",
          });
        }
        if (!this.admitHttp(res, "browser")) return;
        this.workspace.http(req, res);
        return;
      }
      if (req.url?.startsWith("/api/fleet/peer/")) {
        if (this.workspace.isolated || !this.workspace.peerHttp)
          return this.json(res, 404, {
            error: "Fleet enrollment unavailable.",
          });
        if (!this.admitHttp(res, "peer")) return;
        this.workspace.peerHttp(req, res);
        return;
      }
      const path = new URL(req.url!, this.origin).pathname;
      const device = this.authenticate(req);
      if (
        !(device ? this.admitHttp(res, "browser") : this.admitPublic(req, res))
      )
        return;
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
      if (path === "/session" && req.method === "GET") {
        if (!device)
          return this.json(res, 401, {
            error: "Pair this device from the desktop.",
          });
        return this.json(res, 200, {
          csrf: device.csrf,
          device: cleanDevice(device),
        });
      }
      if (path === "/api/capabilities" && req.method === "GET") {
        this.workspace.http(req, res);
        return;
      }
      if (path.startsWith("/api/")) {
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
          res.setHeader("Set-Cookie", this.cookie("", 0));
          return this.json(res, 200, { ok: true });
        }
        if (
          path.startsWith("/api/fleet/admin/") ||
          path.startsWith("/api/fleet/commands/")
        ) {
          const service = path.startsWith("/api/fleet/admin/")
            ? this.workspace.fleetAdminHttp
            : this.workspace.fleetCommandsHttp;
          if (this.workspace.isolated || !service)
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
          this.delegateFleetRequest(req, res, device);
          service(req, res);
          return;
        }
        if (this.workspace.isolated) {
          if (path.startsWith("/api/agent-sources/"))
            return this.json(res, 403, {
              error: "Previews do not connect to other Loop workspaces.",
            });
        }
        const contract = pairedHostRoutes.find(
          (route) =>
            req.method === route.method && path === "/api" + route.path,
        );
        if (contract) {
          if (
            contract.path === workspaceApi.workspaceDevices.path ||
            contract.path === workspaceApi.workspaceRevoke.path
          ) {
            contract.params.parse({});
            contract.query.parse(
              Object.fromEntries(new URL(req.url!, this.origin).searchParams),
            );
            let output: unknown;
            if (contract.path === workspaceApi.workspaceRevoke.path) {
              const input = contract.body.parse(await body(req));
              this.revoke(input.id);
              output = { ok: true };
            } else {
              const hasBody =
                Number(req.headers["content-length"] ?? 0) > 0 ||
                req.headers["transfer-encoding"] !== undefined;
              contract.body.parse(hasBody ? {} : undefined);
              output = this.deviceList().map(cleanDevice);
            }
            const projected = contract.response.safeParse(output);
            if (!projected.success)
              return this.json(res, 500, {
                error:
                  "The workspace response is unavailable. Please try again.",
              });
            return this.json(res, 200, projected.data);
          }
          contract.params.parse({});
          contract.query.parse(
            Object.fromEntries(new URL(req.url!, this.origin).searchParams),
          );
          // Agent-source discovery accepts no body, including on previews.
          const hasBody =
            Number(req.headers["content-length"] ?? 0) > 0 ||
            req.headers["transfer-encoding"] !== undefined;
          contract.body.parse(hasBody ? {} : undefined);
          let output: unknown = [];
          if (!this.workspace.isolated) {
            const current = this.delegateFleetRequest(req, res, device);
            output = await this.agentSources().discover();
            current();
          }
          const projected = contract.response.safeParse(output);
          if (!projected.success)
            return this.json(res, 500, {
              error: "The workspace response is unavailable. Please try again.",
            });
          return this.json(res, 200, projected.data);
        }
        if (path.startsWith("/api/agent-sources/")) {
          const match = /^\/api\/agent-sources\/([^/]+)\/(.+)$/.exec(path);
          if (!match) return this.json(res, 404, { error: "Not found" });
          if (
            (req.headers.origin && !this.validOrigin(req)) ||
            req.headers["sec-fetch-site"] === "cross-site" ||
            req.headers["x-http-method-override"] !== undefined ||
            req.headers["x-method-override"] !== undefined
          )
            return this.json(res, 403, {
              error: "Source authorization rejected.",
            });
          const query = new URL(req.url!, this.origin).search;
          await this.agentSources().proxy(
            req,
            res,
            decodeURIComponent(match[1]),
            match[2] + query,
            this.delegateFleetRequest(req, res, device),
          );
          return;
        }
        this.workspace.http(req, res);
        return;
      }
      if (req.method !== "GET")
        return this.json(res, 404, { error: "Not found" });
      const root = webRoot;
      const assetPath = decodeURIComponent(path);
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
        ".wasm": "application/wasm",
        ".txt": "text/plain; charset=utf-8",
      };
      res.setHeader(
        "Content-Type",
        types[extname(asset)] ?? "application/octet-stream",
      );
      const cacheControl = assetCacheControl(assetPath);
      res.setHeader("Cache-Control", cacheControl);
      if (cacheControl !== "no-store") {
        const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
        res.setHeader("ETag", etag);
        if (
          req.headers["if-none-match"]?.split(",").some((value) => {
            const candidate = value.trim().replace(/^W\//, "");
            return candidate === "*" || candidate === etag.slice(2);
          })
        ) {
          res.statusCode = 304;
          res.end();
          return;
        }
      }
      const content = await readFile(asset);
      res.setHeader("Content-Length", content.length);
      res.end(content);
    } catch (error) {
      problemReply(res, error, "Invalid request or unavailable asset.");
    }
  }
  private admin = jsonServer(
    (path) => {
      switch (path) {
        case "/status":
          return () => [200, this.status()];
        case "/pair":
          return () => [200, this.pair()];
        case "/devices":
          return () => [200, this.deviceList().map(cleanDevice)];
        case "/revoke":
          return (input) => {
            // Revocation remains available when clock/expiry failures prevent authentication.
            if (typeof input.id !== "string" || !input.id)
              throw new Error("Unknown device");
            this.revoke(input.id);
            return [200, { revoked: true }];
          };
        case "/stop":
          return () => [
            200,
            { stopping: true },
            () => {
              void this.onStop();
            },
          ];
        default:
          return async (input) => [
            200,
            await this.workspace.admin(path, input),
          ];
      }
    },
    {
      token: () => this.adminToken,
      authMessage: "Local control authentication required",
      invalidMessage: "Invalid control request",
      methodStatus: 405,
    },
  );
  async close() {
    this.multiplex?.close();
    if (this.stopped) return;
    this.stopped = true;
    this.workspace.tokenEvents?.close();
    this.closeFleetRequests();
    clearInterval(this.heartbeat);
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
    await unlink(join(this.dir, PROCESS_FILES.control)).catch(() => {});
    if (this.socketPath) await rm(this.socketPath, { force: true });
  }
}
