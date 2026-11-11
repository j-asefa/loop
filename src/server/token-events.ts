import * as eventsQueries from "./sql/events.js";
import * as tokenEventCursorsQueries from "./sql/token-event-cursors.js";
import * as changeWatermarkQueries from "./sql/change-watermark.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { workspaceApi } from "../shared/workspace-api.js";
import type { CardAuthorization } from "../shared/card-access.js";
import {
  TokenEventAck,
  type WorkspaceFrameV3,
} from "../shared/workspace-events.js";
import { activeIntegrationToken } from "./card-tokens.js";
import { db } from "./db.js";
import { Problem } from "./domain.js";
import { projectResponse } from "./registrar.js";
import { connectWorkspaceEvents } from "./workspace-events.js";

const PAGE_BYTES = 512 * 1024;
const RECHECK_MS = 25_000;
const MAX_UNCONFIRMED_FRAMES = 1024;

/** Preserve the historical array and whole rows. One oversize first row is
 * returned intact so the caller can always make forward progress. */
export function eventPage(owner: string, after: number, bearer: boolean) {
  if (!bearer)
    return projectResponse(
      workspaceApi.events,
      eventsQueries.page(db, owner, after),
    );
  const page = [];
  let bytes = 2;
  for (const row of eventsQueries.iteratePage(db, owner, after)) {
    const event = projectResponse(workspaceApi.events, [row])[0];
    const size =
      Buffer.byteLength(JSON.stringify(event)) + (page.length ? 1 : 0);
    if (page.length && bytes + size > PAGE_BYTES) break;
    page.push(event);
    bytes += size;
    if (bytes >= PAGE_BYTES) break;
  }
  return page;
}

type Checkpoint = {
  epoch: string | null;
  cursor: number;
  connection_id: string;
};

/** GET/HEAD without an upgrade checks admission but never opens a connection. */
export function requireTokenEventUpgrade(res: Response) {
  const tokenId: string | undefined = res.locals.bearer?.tokenId;
  if (!tokenId || !activeIntegrationToken(res.locals.owner, tokenId, "read"))
    throw new Problem(403, "A read integration token is required");
  res.setHeader("Upgrade", "websocket");
  res.setHeader("Cache-Control", "no-store");
  return res.status(426).json({ error: "WebSocket upgrade required" });
}

class TokenEventConnection extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly connection = randomUUID();
  readonly offers = new Map<number, { epoch: string; reset: boolean }>();
  private epoch: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }

  constructor(
    readonly owner: string,
    readonly tokenId: string,
    private socket: WebSocket,
    reauthorize: () => CardAuthorization,
    onClose: () => void,
  ) {
    super();
    socket.once("close", () => this.close());
    socket.on("error", () => this.close());
    this.once("close", onClose);
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Acknowledgements must be JSON text");
        const ack = TokenEventAck.parse(JSON.parse(data.toString()));
        // Handshakes and acknowledgements share the normal token request limit.
        const identity = reauthorize();
        if (identity.owner !== owner || identity.tokenId !== tokenId)
          throw new Error("Token identity changed");
        this.confirm(ack);
      } catch {
        this.close();
      }
    });
  }

  current() {
    const row = tokenEventCursorsQueries.current(db, this.tokenId, this.owner);
    return (
      row?.connection_id === this.connection &&
      activeIntegrationToken(this.owner, this.tokenId, "read")
    );
  }

  start() {
    let alive = true;
    this.socket.on("pong", () => {
      alive = true;
    });
    this.timer = setInterval(() => {
      try {
        if (!this.current() || !alive) return this.close();
        alive = false;
        this.socket.ping();
      } catch {
        this.close();
      }
    }, RECHECK_MS);
    this.timer.unref();
  }

  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) return;
    if (!this.current()) return this.close();
    // Preserve the canonical browser frame bytes.
    const frame = JSON.parse(data) as WorkspaceFrameV3;
    if (this.epoch !== frame.epoch || frame.type === "reset")
      this.offers.clear();
    if (
      this.offers.size >= MAX_UNCONFIRMED_FRAMES &&
      !this.offers.has(frame.cursor)
    )
      return this.close();
    this.socket.send(data);
    this.epoch = frame.epoch;
    this.offers.set(frame.cursor, {
      epoch: frame.epoch,
      reset: frame.type === "reset",
    });
  }

  private confirm(query: { epoch: string; cursor: number }) {
    const offered = this.offers.get(query.cursor);
    if (!offered || offered.epoch !== query.epoch)
      throw new Error("This connection did not offer that checkpoint");
    db.transaction(() => {
      const clock = changeWatermarkQueries.clock(db, this.owner);
      if (
        !this.current() ||
        clock?.epoch !== query.epoch ||
        query.cursor > clock.last_event_id
      )
        throw new Error("This connection's checkpoint is no longer current");
      // Preserve the offered reset's meaning even if later commits overtake an
      // invalid saved cursor. Ordinary replay cannot rewind confirmed progress.
      tokenEventCursorsQueries.confirm(db, {
        epoch: query.epoch,
        reset: offered.reset ? 1 : 0,
        cursor: query.cursor,
        lastEvent: clock.last_event_id,
        token: this.tokenId,
        owner: this.owner,
        connection: this.connection,
      });
    }).immediate();
    for (const id of this.offers.keys())
      if (id < query.cursor) this.offers.delete(id);
  }

  close(_code?: number, _reason?: string) {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSED;
    clearInterval(this.timer);
    this.offers.clear();
    this.emit("close");
    // Never retain an untracked slow reader during shutdown or replacement.
    // Unconfirmed frames replay after reconnect, including discarded output.
    this.socket.terminate();
  }
}

/** Both production listeners route the dedicated path here after origin checks.
 * The supplied authorizer resolves the mounted contract, never browser cookies. */
export function createTokenEventSockets(
  authorize: (req: IncomingMessage) => CardAuthorization,
) {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  const streams = new Map<string, TokenEventConnection>();
  let closing = false;
  return {
    upgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      admit?: () => boolean,
    ) {
      socket.on("error", () => socket.destroy());
      try {
        if (closing) throw new Problem(503, "Server is shutting down");
        const url = new URL(req.url || "", "http://loop");
        const query = workspaceApi.channels.tokenEvents.query.safeParse(
          Object.fromEntries(url.searchParams),
        );
        if (
          !query.success ||
          [...url.searchParams.keys()].length !==
            new Set(url.searchParams.keys()).size
        )
          throw new Problem(400, "Invalid event query");
        const identity = authorize(req);
        const { owner, tokenId } = identity;
        if (!activeIntegrationToken(owner, tokenId, "read"))
          throw new Problem(403, "A read integration token is required");
        if (streams.size >= 256 && !streams.has(tokenId))
          throw new Problem(429, "Too many event connections");
        if (admit && !admit()) return;
        sockets.handleUpgrade(req, socket, head, (ws) => {
          const stream = new TokenEventConnection(
            owner,
            tokenId,
            ws,
            () => authorize(req),
            () => {
              if (streams.get(tokenId) === stream) streams.delete(tokenId);
            },
          );
          try {
            const checkpoint = db
              .transaction(() => {
                if (!activeIntegrationToken(owner, tokenId, "read"))
                  throw new Problem(401, "Invalid integration credential");
                return tokenEventCursorsQueries.connect(
                  db,
                  tokenId,
                  owner,
                  stream.connection,
                ) as Checkpoint;
              })
              .immediate();
            streams.get(tokenId)?.close();
            streams.set(tokenId, stream);
            stream.start();
            const replay = new URL("http://loop/api/events/stream?v=3");
            replay.searchParams.set(
              "cursor",
              String(query.data.after ?? checkpoint.cursor),
            );
            if (checkpoint.epoch)
              replay.searchParams.set("epoch", checkpoint.epoch);
            else if (query.data.after !== undefined) {
              const clock = changeWatermarkQueries.epoch(db, owner);
              if (clock) replay.searchParams.set("epoch", clock.epoch);
            }
            connectWorkspaceEvents(stream, replay, owner, "");
          } catch {
            stream.close();
          }
        });
      } catch (error) {
        const status = error instanceof Problem ? error.status : 500;
        const body = JSON.stringify({
          error:
            error instanceof Problem
              ? error.message
              : "Event connection unavailable",
        });
        socket.end(
          `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${status === 429 ? "Retry-After: 60\r\n" : ""}\r\n${body}`,
        );
      }
    },
    close() {
      if (closing) return;
      closing = true;
      for (const stream of streams.values()) stream.close();
      sockets.close();
    },
  };
}
