import {
  Agent,
  createServer,
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export type Backend = { generation: number; path: string };
type Active = Backend & { sockets: Set<Duplex>; requests: Set<ClientRequest> };

// RFC 9110 connection-specific fields, plus Loop55's private probe marker.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "x-loop55-probe",
  "x-loop-probe",
]);
function forwardable(headers: IncomingHttpHeaders) {
  const named = new Set(
    String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim()),
  );
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers))
    if (value !== undefined && !HOP.has(key) && !named.has(key))
      out[key] = value;
  return out;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>Loop55 is reconnecting</title><style>body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#222}main{max-width:22rem;padding:2rem;text-align:center}@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}}</style></head><body><main><h1>Loop55 is reconnecting…</h1><p>Loop55 is restarting on your computer. This page retries automatically.</p></main></body></html>`;

/**
 * Stable public listener of the connection service. Forwards each request or
 * WebSocket to the application launch registered when it arrived; nothing is
 * queued or replayed across launches.
 */
export class Relay {
  private server = createServer((req, res) => this.http(req, res));
  /**
   * Never pools a connection to the application. A pooled socket the
   * application closes on its own idle timeout is reset on the next request,
   * and nothing distinguishes that reset from one where the application had
   * already acted: `reusedSocket` is true either way. Reporting both as unknown
   * sends people to check sends that never happened, and reporting both as
   * retryable risks a duplicate. A fresh connection per request removes the
   * ambiguity instead of guessing, and these are local unix sockets.
   */
  private agent = new Agent({ keepAlive: false, maxSockets: 256 });
  private current?: Active;
  /** Sockets of a detached generation, waiting out their drain. */
  private draining?: {
    generation: number;
    sockets: Set<Duplex>;
    timer: NodeJS.Timeout;
  };
  /** Called when the registered socket refuses a connection. */
  onUnreachable: (generation: number) => void = () => {};
  constructor(private drainMs = 5000) {
    this.server.on("upgrade", (req, socket, head) =>
      this.upgrade(req, socket, head),
    );
    // cloudflared multiplexes browsers over a few origin connections.
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 60000;
    this.server.maxConnections = 512;
  }
  get port() {
    return (this.server.address() as { port: number } | null)?.port ?? 0;
  }
  get generation() {
    return this.current?.generation;
  }
  listen(host: string, port = 0) {
    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }
  /** Publishes a verified backend. The previous launch keeps only what it already admitted. */
  setBackend(backend?: Backend) {
    const previous = this.current;
    // The same generation registering again is one launch recovering from a
    // transient detach, not a takeover. It keeps the sockets it already
    // admitted, and the drain armed when it detached is called off: a
    // recovery that takes two seconds must not kill live WebSockets at five.
    const resumed =
      backend && this.draining?.generation === backend.generation
        ? this.draining
        : undefined;
    if (resumed) {
      clearTimeout(resumed.timer);
      this.draining = undefined;
    }
    this.current = backend
      ? {
          ...backend,
          sockets: resumed?.sockets ?? new Set(),
          requests: new Set(),
        }
      : undefined;
    if (previous && previous.generation !== backend?.generation) {
      const timer = setTimeout(() => {
        for (const socket of previous.sockets) socket.destroy();
        if (this.draining?.timer === timer) this.draining = undefined;
      }, this.drainMs);
      timer.unref();
      this.draining = {
        generation: previous.generation,
        sockets: previous.sockets,
        timer,
      };
    }
  }
  async close() {
    const current = this.current;
    const draining = this.draining;
    this.current = undefined;
    this.draining = undefined;
    if (draining) clearTimeout(draining.timer);
    this.agent.destroy();
    for (const socket of [
      ...(current?.sockets ?? []),
      ...(draining?.sockets ?? []),
    ])
      socket.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  private unavailable(req: IncomingMessage, res: ServerResponse) {
    const page =
      req.method === "GET" &&
      !req.url?.startsWith("/api/") &&
      /text\/html/.test(String(req.headers.accept ?? ""));
    res.writeHead(503, {
      "Content-Type": page ? "text/html; charset=utf-8" : "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "2",
      "X-Loop55-Unavailable": "restarting",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(
      page
        ? PAGE
        : JSON.stringify({
            error: "Loop55 is restarting. Try again in a moment.",
            reconnecting: true,
          }),
    );
  }
  private http(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? "";
    // Origin-form only; the private probe namespace never leaves the machine.
    if (!path.startsWith("/") || path.startsWith("/__loop")) {
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const backend = this.current;
    if (!backend) return this.unavailable(req, res);
    let connected = false;
    const upstream = request({
      socketPath: backend.path,
      method: req.method,
      path,
      headers: forwardable(req.headers),
      setHost: false,
      agent: this.agent,
    });
    backend.requests.add(upstream);
    upstream.once("socket", (socket: Socket) => {
      if (!socket.connecting) connected = true;
      else socket.once("connect", () => (connected = true));
    });
    upstream.on("response", (answer) => {
      const headers = forwardable(answer.headers);
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers);
      answer.pipe(res);
      answer.on("aborted", () => res.destroy());
      answer.on("error", () => res.destroy());
    });
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      backend.requests.delete(upstream);
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      if (!connected) {
        if (["ECONNREFUSED", "ENOENT"].includes(error.code ?? ""))
          this.onUnreachable(backend.generation);
        // Never reached the application: safe for the browser to retry.
        return this.unavailable(req, res);
      }
      if (req.method === "GET" || req.method === "HEAD")
        return this.unavailable(req, res);
      // The application may have acted on it. Report uncertainty; never replay.
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Loop55-Outcome": "unknown",
      });
      res.end(
        JSON.stringify({
          error:
            "Loop55 restarted before confirming this request. Its outcome is unknown; check before trying again.",
          outcome: "unknown",
        }),
      );
    });
    res.on("close", () => {
      backend.requests.delete(upstream);
      if (!res.writableFinished) upstream.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  }
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const backend = this.current;
    const refuse = () => {
      if (!socket.destroyed)
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nX-Loop55-Unavailable: restarting\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
    };
    const path = req.url ?? "";
    if (!backend || !path.startsWith("/") || path.startsWith("/__loop"))
      return refuse();
    socket.on("error", () => {});
    const upstream = connect(backend.path);
    let open = false;
    backend.sockets.add(socket);
    const close = () => {
      backend.sockets.delete(socket);
      upstream.destroy();
      socket.destroy();
    };
    upstream.once("connect", () => {
      open = true;
      const lines = [`${req.method} ${path} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        if (["x-loop55-probe", "x-loop-probe"].includes(name.toLowerCase()))
          continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (!open) {
        backend.sockets.delete(socket);
        if (["ECONNREFUSED", "ENOENT"].includes(error.code ?? ""))
          this.onUnreachable(backend.generation);
        return refuse();
      }
      close();
    });
    upstream.on("close", () => {
      if (open) close();
    });
    socket.on("close", close);
  }
}
