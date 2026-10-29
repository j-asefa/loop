import { workspaceApi } from "../shared/workspace-api.js";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { allowedOrigin, workspaceSession } from "./access.js";
import { connectWorkspaceEvents } from "./workspace-events.js";
import { createTokenEventSockets } from "./token-events.js";

export const eventSocketContract = workspaceApi.channels.events;

/** Separate browser-session and read-token channels on the server listener. */
export function installEventSockets(
  server: Server,
  authorizeIntegrationToken: Parameters<typeof createTokenEventSockets>[0],
) {
  const tokenSockets = createTokenEventSockets(authorizeIntegrationToken);
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  const owners = new Map<WebSocket, string>();
  const epoch = randomUUID();
  const pending = new Set<Duplex>();
  let closing = false;
  const reject = (socket: Duplex, status: number) =>
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const failed = () => socket.destroy();
    const timeout = setTimeout(failed, 10_000);
    try {
      const url = new URL(req.url || "", "http://loop");
      if (url.pathname === "/api" + workspaceApi.channels.tokenEvents.path) {
        if (
          (req.headers.origin && !allowedOrigin(req)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return reject(socket, 403);
        return tokenSockets.upgrade(req, socket, head);
      }
      if (url.pathname !== "/api" + eventSocketContract.path)
        return reject(socket, 404);
      if (
        req.headers.authorization !== undefined ||
        !allowedOrigin(req) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return reject(socket, 403);
      const session = await workspaceSession(req);
      if (!session) return reject(socket, 401);
      if (closing || socket.destroyed) return;
      const owner = session.user.id;
      if ([...owners.values()].filter((id) => id === owner).length >= 12)
        return reject(socket, 429);
      sockets.handleUpgrade(req, socket, head, (ws) => {
        owners.set(ws, owner);
        ws.on("error", () => {});
        const stop = connectWorkspaceEvents(
          ws,
          url,
          owner,
          epoch,
          undefined,
          eventSocketContract,
        );
        let alive = true,
          checking = false;
        ws.on("pong", () => {
          alive = true;
        });
        const heartbeat = setInterval(async () => {
          if (!alive) return ws.terminate();
          if (checking) return;
          checking = true;
          try {
            // A cookie grants no access after its session expires or is revoked.
            const current = await workspaceSession(req);
            if (current?.user.id !== owner) ws.close(4003, "Session expired");
            else if (ws.readyState === WebSocket.OPEN) {
              alive = false;
              ws.ping();
            }
          } catch {
            // A failed lookup does not establish expiry. Close fail-closed,
            // but let the browser reconnect without clearing a valid session.
            ws.close(1011, "Session temporarily unavailable");
          } finally {
            checking = false;
          }
        }, 25_000);
        ws.on("close", () => {
          stop();
          clearInterval(heartbeat);
          owners.delete(ws);
        });
        // Commands continue through authenticated HTTP and durable receipts.
        ws.on("message", () => ws.close(1008, "Read-only event connection"));
      });
    } catch {
      if (!socket.destroyed) reject(socket, 403);
    } finally {
      pending.delete(socket);
      clearTimeout(timeout);
    }
  }
  server.on("upgrade", (req, socket, head) => {
    // HTTP hands ownership of upgraded streams to us. Keep an error handler
    // through rejected writes too: a peer can reset before socket.end flushes.
    // Install it before the global limit so every rejection path is covered.
    socket.on("error", () => socket.destroy());
    if (closing) return reject(socket, 503);
    if (owners.size + pending.size >= 256) return reject(socket, 429);
    pending.add(socket);
    socket.once("close", () => pending.delete(socket));
    void upgrade(req, socket, head);
  });
  // http.Server.close does not close upgraded sockets. Stop them before waiting
  // for the HTTP listener, including callers outside the CLI signal handlers.
  const close = server.close;
  server.close = function (...args) {
    closing = true;
    tokenSockets.close();
    for (const socket of pending) socket.destroy();
    for (const ws of owners.keys()) ws.terminate();
    return close.apply(this, args);
  };
  server.once("close", () => sockets.close());
}
