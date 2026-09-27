import https from "node:https";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { TLSSocket } from "node:tls";
import { db } from "../db.js";
import { matchesSecret } from "./contracts.js";
import { handleGateway } from "./gateway.js";

const destination = new URL(
  process.env.LOOP_HAPI_URL || "http://127.0.0.1:3006",
);
if (!["127.0.0.1", "localhost", "hapi"].includes(destination.hostname))
  throw new Error("Raw Hub must be isolated on the app host");
const sockets = new Map<TLSSocket, string>();
function authorize(req: http.IncomingMessage, gateway = false): any {
  const socket = req.socket as TLSSocket;
  if (!socket.authorized) throw new Error("Mutual TLS is required");
  const e = db
    .prepare(
      "SELECT * FROM execution_environments WHERE certificate_fingerprint=? AND revoked_at IS NULL",
    )
    .get(socket.getPeerCertificate()?.fingerprint256) as any;
  if (
    !e ||
    (!gateway &&
      !matchesSecret(
        String(req.headers["x-loop-environment-token"] || ""),
        e.credential_hash,
      ))
  )
    throw new Error("Environment identity unavailable");
  sockets.set(socket, e.host_id);
  socket.once("close", () => sockets.delete(socket));
  return e;
}
function proxy(req: http.IncomingMessage, e: any) {
  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: destination.host,
    "x-loop-namespace": e.namespace,
  };
  delete headers["x-loop-environment-token"];
  return http.request(destination.origin + req.url, {
    method: req.method,
    headers,
  });
}
export const server = https.createServer(
  {
    key: readFileSync(process.env.LOOP_PRIVATE_KEY!),
    cert: readFileSync(process.env.LOOP_PRIVATE_CERT!),
    ca: readFileSync(process.env.LOOP_PRIVATE_CA!),
    requestCert: true,
    rejectUnauthorized: true,
  },
  async (req, res) => {
    try {
      const isGateway = req.url === "/mcp",
        e = authorize(req, isGateway);
      if (isGateway) {
        let length = 0,
          parts: Buffer[] = [];
        for await (const part of req) {
          length += part.length;
          if (length > 100000) throw new Error("Request too large");
          parts.push(part);
        }
        await handleGateway(
          req,
          res,
          e.host_id,
          length ? JSON.parse(Buffer.concat(parts).toString()) : undefined,
        );
        return;
      }
      // Worker surface is CLI transport only. Interactive APIs belong to Loop.
      if (
        !req.url?.startsWith("/cli/") &&
        !req.url?.startsWith("/socket.io/") &&
        req.url !== "/health"
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const upstream = proxy(req, e);
      upstream.on("response", (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(401);
      res.end('{"error":"Private environment access denied"}');
    }
  },
);
server.on("upgrade", (req, socket, head) => {
  try {
    const e = authorize(req);
    if (!req.url?.startsWith("/socket.io/")) throw new Error("Unknown socket");
    const upstream = proxy(req, e);
    upstream.on("upgrade", (response, remote, remoteHead) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          Object.entries(response.headers)
            .map(([k, v]) => k + ": " + v)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote);
      remote.pipe(socket);
      socket.on("close", () => remote.destroy());
      remote.on("error", () => socket.destroy());
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  } catch {
    socket.destroy();
  }
});
setInterval(() => {
  for (const [socket, environment] of sockets) {
    const e = db
      .prepare("SELECT revoked_at FROM execution_environments WHERE host_id=?")
      .get(environment) as any;
    if (!e || e.revoked_at) socket.destroy();
  }
}, 1000).unref();
server.listen(
  Number(process.env.LOOP_PRIVATE_PORT || 3007),
  process.env.LOOP_PRIVATE_HOST || "0.0.0.0",
);
