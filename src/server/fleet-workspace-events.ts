import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type Database from "better-sqlite3";
import { FleetOrigin } from "../shared/fleet.js";
import { FleetSecret } from "../shared/fleet-credentials.js";
import {
  FLEET_EVENTS_PATH,
  FLEET_EVENT_BYTES,
  FLEET_EVENT_BUFFER_BYTES,
  FleetEventSubscription,
  FleetEventResponse,
  fleetEventProjection,
} from "../shared/fleet-workspace-events.js";
import { WorkspaceFrameV3 } from "../shared/workspace-events.js";
import { Problem } from "../shared/problem.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import type {
  connectWorkspaceEvents,
  WorkspaceEventConnection,
} from "./workspace-events.js";
import { FleetProof } from "./fleet-proof.js";

/** This upgrade has its own machine authentication and can only subscribe to
 * this companion's enrolled owner. It never accepts a device cookie or an
 * arbitrary workspace route, source, owner, URL or executable operation. */
export class FleetWorkspaceEvents {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 40 * 1024,
    perMessageDeflate: false,
  });
  private readonly clients = new Map<WebSocket, () => void>();
  private readonly unobserve: () => void;
  private stopped = false;
  private readonly proof: FleetProof;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly credentials: FleetCredentials,
    private readonly owner: string,
    private readonly connect: typeof connectWorkspaceEvents,
    secrets: ConstructorParameters<typeof FleetProof>[2],
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
    this.unobserve = authority.observe(owner, () => {
      for (const check of this.clients.values()) check();
    });
  }
  private authorize(token: string) {
    if (this.stopped)
      throw new Problem(403, "This workspace does not admit fleet events.");
    const result = this.credentials.authenticate(token);
    if (result.owner !== this.owner || result.context.operation !== "events")
      throw new Problem(
        403,
        "This credential cannot subscribe to workspace events.",
      );
    return result;
  }
  upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    origin: string,
    admit?: () => boolean,
  ) {
    const reject = (status: number) =>
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`,
      );
    try {
      const parsed = FleetOrigin.safeParse(origin);
      if (
        !parsed.success ||
        req.headers.host !== new URL(parsed.data).host ||
        req.url !== FLEET_EVENTS_PATH ||
        req.method !== "GET" ||
        req.headers["x-loop-fleet-version"] !== "1" ||
        [
          "origin",
          "cookie",
          "x-loop-csrf",
          "x-http-method-override",
          "x-method-override",
          "sec-websocket-protocol",
        ].some((name) => req.headers[name] !== undefined) ||
        Object.keys(req.headers).some((name) => name.startsWith("sec-fetch-"))
      )
        return reject(403);
      const header = req.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer "))
        return reject(403);
      const token = FleetSecret.parse(header.slice(7));
      const access = this.authorize(token);
      if (admit && !admit()) return;
      this.server.handleUpgrade(req, socket, head, (ws) => {
        let stop: (() => void) | undefined;
        let remaining = 16;
        let alive = true;
        const close = (code = 4009) =>
          ws.close(code, "Reconcile this source and reconnect.");
        const check = () => {
          try {
            const current = this.authorize(token);
            if (current.context.directory !== access.context.directory)
              throw new Error();
            return true;
          } catch {
            close(4001);
            return false;
          }
        };
        this.clients.set(ws, check);
        const expiry = setTimeout(() => close(4001), access.remainingMs);
        const first = setTimeout(() => close(1008), 5000);
        const heartbeat = setInterval(() => {
          remaining = 16;
          if (!alive || !check()) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, 15_000);
        expiry.unref();
        first.unref();
        heartbeat.unref();
        ws.on("pong", () => {
          alive = true;
        });
        ws.on("error", () => ws.terminate());
        ws.on("message", (raw, binary) => {
          if (binary || --remaining < 0 || !check()) return close(1008);
          try {
            const selection = FleetEventSubscription.parse(
              JSON.parse(raw.toString()),
            );
            clearTimeout(first);
            stop?.();
            const url = new URL(FLEET_EVENTS_PATH, origin);
            for (const [name, value] of Object.entries({
              epoch: selection.epoch,
              cursor: String(selection.cursor),
              v: "3",
            }))
              url.searchParams.set(name, value);
            // The existing stream owns SQL replay and subscribes before reading.
            // Every outgoing frame rechecks authority, including an already
            // scheduled pump after a revoke and before observer delivery.
            let sequence = 0;
            const guarded: WorkspaceEventConnection = {
              get readyState() {
                return ws.readyState;
              },
              get bufferedAmount() {
                return ws.bufferedAmount;
              },
              once: ws.once.bind(ws),
              off: ws.off.bind(ws),
              close: ws.close.bind(ws),
              send: (text) => {
                if (!check() || ws.readyState !== WebSocket.OPEN) return;
                if (Buffer.byteLength(text) > FLEET_EVENT_BYTES)
                  return close(4008);
                const response = FleetEventResponse.parse({
                  version: 1,
                  requestId: selection.requestId,
                  sequence: sequence++,
                  machineId: this.authority.identity.machineId,
                  peer: access.context.peer,
                  grantId: access.context.grantId,
                  directory: access.context.directory,
                  frame: WorkspaceFrameV3.parse(JSON.parse(text)),
                });
                const signed = JSON.stringify({
                  response,
                  signature: this.proof.sign("workspace-event", response),
                });
                if (
                  ws.bufferedAmount + Buffer.byteLength(signed) >
                  FLEET_EVENT_BUFFER_BYTES
                )
                  return close(4008);
                ws.send(signed);
              },
            };
            stop = this.connect(
              guarded,
              url,
              this.owner,
              "",
              undefined,
              undefined,
              (event) => fleetEventProjection(event, selection),
            );
          } catch {
            close(1008);
          }
        });
        ws.once("close", () => {
          clearTimeout(expiry);
          clearTimeout(first);
          clearInterval(heartbeat);
          stop?.();
          this.clients.delete(ws);
        });
      });
    } catch {
      reject(403);
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.unobserve();
    for (const ws of this.clients.keys()) ws.terminate();
    this.server.close();
  }
}
