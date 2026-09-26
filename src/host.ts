import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat, unlink } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
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

type Device = {
  id: string;
  name: string;
  hash: string;
  csrf: string;
  expires: number;
};
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
    // "bearer" returns the device token to a native client instead of setting a cookie.
    credential: z.enum(["cookie", "bearer"]).default("cookie"),
  })
  .strict();

export class Host {
  /** Optional workspace application. The legacy session protocol stays testable. */
  workspace?: {
    http: (req: IncomingMessage, res: ServerResponse) => void;
    status: () => unknown;
    admin: (action: string, input: any) => Promise<unknown>;
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
  ) {
    this.state = new State(dir, initial);
  }
  emit = (event: AdapterEvent) => {
    if (this.stopped) return;
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
      if (!this.devices.has(id) || this.devices.get(id)!.expires <= Date.now())
        socket.close(4003, "Device revoked");
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
  async listen() {
    this.publicServer.on("upgrade", (req, socket, head) => {
      const device = this.authenticate(req);
      if (
        !(this.bearer(req) ? this.validHost(req) : this.validOrigin(req)) ||
        !device ||
        new URL(req.url!, this.origin).pathname !== "/ws" ||
        this.clients.size >= 12
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.ws.handleUpgrade(req, socket, head, (ws) => {
        this.clients.set(ws, device.id);
        const url = new URL(req.url!, this.origin);
        const cleanup = this.workspace?.connect(ws, url);
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
    await new Promise<void>((resolve) =>
      this.publicServer.listen(0, "127.0.0.1", resolve),
    );
    this.port = (this.publicServer.address() as { port: number }).port;
    this.origin = `http://127.0.0.1:${this.port}`;
    this.workspace?.originChanged(this.origin);
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
    this.origin = url.origin;
    this.workspace?.originChanged(this.origin);
    // Cookies are origin-scoped, and bearer devices are deliberately revoked too:
    // reconnecting after a rotation is an in-person re-pair via a fresh `loop pair` QR.
    this.pairs.clear();
    for (const d of [...this.devices.keys()]) this.revoke(d);
  }
  pair() {
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
        devices: [...this.devices.values()].map(cleanDevice),
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
      devices: [...this.devices.values()].map(cleanDevice),
      pid: process.pid,
    };
  }
  private revoke(id: string) {
    this.devices.delete(id);
    for (const [s, d] of this.clients)
      if (d === id) s.close(4003, "Device revoked");
    this.saveDevices();
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
  // Origin checks defend against a browser attaching the cookie ambiently.
  // An explicit Authorization header is never attached that way.
  private bearer(req: IncomingMessage) {
    return req.headers.authorization !== undefined;
  }
  private get cookieName() {
    return this.origin.startsWith("https:") ? "__Host-loop" : "loop_local";
  }
  private cookie(token: string, expires: number) {
    const secure = this.origin.startsWith("https:");
    const age = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    return `${this.cookieName}=${token}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${age}`;
  }
  private authenticate(req: IncomingMessage) {
    const header = req.headers.authorization;
    const token =
      header === undefined
        ? req.headers.cookie
            ?.split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith(this.cookieName + "="))
            ?.slice(this.cookieName.length + 1)
        : header.startsWith("Bearer ")
          ? header.slice(7)
          : undefined;
    if (!token || token.length > 100) return;
    return [...this.devices.values()].find(
      (d) => equal(d.hash, hash(token)) && d.expires > Date.now(),
    );
  }
  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  private async http(req: IncomingMessage, res: ServerResponse) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (!this.validHost(req))
      return this.json(res, 403, { error: "Unrecognized host." });
    try {
      const path = new URL(req.url!, this.origin).pathname;
      if (path === "/pair" && req.method === "POST") {
        this.attempts = this.attempts.filter((t) => Date.now() - t < 60000);
        if (this.attempts.length >= 20)
          return this.json(res, 429, {
            error: "Too many pairing attempts. Try in one minute.",
          });
        this.attempts.push(Date.now());
        const input = Pair.parse(await body(req));
        // A bearer credential is only returned in the body, never ambiently attached.
        if (input.credential === "cookie" && !this.validOrigin(req))
          return this.json(res, 403, { error: "Origin rejected." });
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
          expires: Date.now() + 7 * 86400000,
        };
        this.devices.set(device.id, device);
        this.saveDevices();
        if (input.credential === "bearer")
          return this.json(res, 200, {
            paired: true,
            token,
            device: cleanDevice(device),
          });
        res.setHeader("Set-Cookie", this.cookie(token, device.expires));
        return this.json(res, 200, { paired: true });
      }
      // A native shell opens its web view here once with its bearer token; the
      // token becomes the HttpOnly cookie the unmodified web client relies on.
      if (path === "/session/open" && req.method === "GET") {
        const device = this.bearer(req) ? this.authenticate(req) : undefined;
        if (device)
          res.setHeader(
            "Set-Cookie",
            this.cookie(
              req.headers.authorization!.slice("Bearer ".length),
              device.expires,
            ),
          );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end('<!doctype html><meta http-equiv="refresh" content="0;url=/">');
        return;
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
          ((!this.bearer(req) && !this.validOrigin(req)) ||
            !equal(String(req.headers["x-loop-csrf"] || ""), device.csrf))
        )
          return this.json(res, 403, {
            error: "Workspace authorization rejected.",
          });
        if (path === "/api/auth/sign-out" && req.method === "POST") {
          this.revoke(device.id);
          return this.json(res, 200, { ok: true });
        }
        if (path === "/api/workspace/devices" && req.method === "GET")
          return this.json(
            res,
            200,
            [...this.devices.values()].map(cleanDevice),
          );
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
      const asset = resolve(
        root,
        path === "/" ? "index.html" : "." + decodeURIComponent(path),
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
      const device = this.devices.get(deviceId);
      if (
        !device ||
        device.expires <= Date.now() ||
        !equal(device.csrf, envelope.csrf)
      )
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
          return this.json(
            res,
            200,
            [...this.devices.values()].map(cleanDevice),
          );
        case "/revoke":
          if (typeof input.id !== "string" || !this.devices.has(input.id))
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
    clearTimeout(this.flush);
    clearInterval(this.heartbeat);
    this.state.save();
    for (const s of this.clients.keys()) s.terminate();
    this.ws.close();
    this.publicServer.closeAllConnections();
    this.adminServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => this.publicServer.close(() => r())),
      new Promise<void>((r) => this.adminServer.close(() => r())),
    ]);
    await unlink(join(this.dir, "control.json")).catch(() => {});
  }
}
