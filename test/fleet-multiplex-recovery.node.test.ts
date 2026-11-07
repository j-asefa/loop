import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { WorkspaceMultiplex } from "../src/server/workspace-multiplex.js";
import type { EventSocket } from "../src/event-socket.js";
import {
  FLEET_EVENT_BYTES,
  FLEET_EVENT_BUFFER_BYTES,
} from "../src/shared/fleet-workspace-events.js";
import { COMPLETE_WORKSPACE_CAPABILITIES } from "../src/shared/workspace-events.js";
import { WorkspaceMuxResponse } from "../src/shared/workspace-multiplex.js";
import { until } from "./helpers.js";

// Loopback transport and controlled source frames exercise the production mux.
// Paired Host authentication has separate mounted-route coverage.
test("malformed source frames and a slow viewer preserve healthy streams and release subscriptions", async () => {
  const sources = new Map<string, EventSocket>();
  const calls = new Map<string, number>();
  const mux = new WorkspaceMultiplex((socket, source) => {
    sources.set(source, socket);
    calls.set(source, (calls.get(source) ?? 0) + 1);
    socket.once("close", () => {
      if (sources.get(source) === socket) sources.delete(source);
    });
    socket.send(
      JSON.stringify({
        serverNow: Date.now(),
        nextDeadline: null,
        v: 3,
        type: "reset",
        epoch: source,
        cursor: 0,
        build: "fixture",
        buildIdentity: null,
        capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
      }),
    );
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => mux.connect(socket));
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const browsers: WebSocket[] = [];
  const connect = async () => {
    const accepted = once(server, "connection");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    browsers.push(ws);
    const frames: ReturnType<typeof WorkspaceMuxResponse.parse>[] = [];
    ws.on("message", (raw) =>
      frames.push(WorkspaceMuxResponse.parse(JSON.parse(raw.toString()))),
    );
    const [upstream] = await accepted;
    await once(ws, "open");
    return { ws, upstream: upstream as WebSocket, frames };
  };
  const subscribe = (ws: WebSocket, source: string) => {
    const id = randomUUID();
    ws.send(
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id,
        source,
        epoch: "",
        cursor: 0,
        conversations: [],
        runs: [],
      }),
    );
    return id;
  };
  const event = (source: string, cursor: number) =>
    JSON.stringify({
      serverNow: Date.now(),
      nextDeadline: null,
      v: 3,
      type: "events",
      epoch: source,
      cursor,
      events: [
        {
          id: cursor,
          event: {
            type: "invalidate",
            scope: { kind: "collection", id: "feed" },
          },
        },
      ],
    });
  try {
    const a = await connect(),
      b = await connect();
    const healthy = subscribe(a.ws, "fixture:healthy");
    let first = subscribe(a.ws, "fixture:faulty"),
      second = subscribe(b.ws, "fixture:faulty");
    await until(
      () =>
        a.frames.some((f) => f.id === healthy) &&
        a.frames.some((f) => f.id === first) &&
        b.frames.some((f) => f.id === second),
    );
    assert.equal(calls.get("fixture:faulty"), 1);
    for (const [index, bad] of [
      "{",
      " ".repeat(FLEET_EVENT_BYTES + 1),
    ].entries()) {
      sources.get("fixture:faulty")!.send(bad);
      await until(
        () =>
          a.frames.some((f) => f.id === first && f.type === "closed") &&
          b.frames.some((f) => f.id === second && f.type === "closed"),
      );
      assert.equal(a.ws.readyState, WebSocket.OPEN);
      assert.equal(b.ws.readyState, WebSocket.OPEN);
      assert.equal(sources.get("fixture:healthy")!.readyState, WebSocket.OPEN);
      sources.get("fixture:healthy")!.send(event("fixture:healthy", index + 1));
      await until(() =>
        a.frames.some(
          (f) =>
            f.id === healthy &&
            f.type === "frame" &&
            f.frame.cursor === index + 1,
        ),
      );
      assert.equal(calls.get("fixture:healthy"), 1);
      first = subscribe(a.ws, "fixture:faulty");
      second = subscribe(b.ws, "fixture:faulty");
      await until(
        () =>
          a.frames.some((f) => f.id === first && f.type === "frame") &&
          b.frames.some((f) => f.id === second && f.type === "frame"),
      );
    }
    // Deterministic socket-buffer pressure at the production send boundary.
    // The other viewer still shares the same source and receives the new event.
    const closed = once(a.ws, "close");
    Object.defineProperty(a.upstream, "bufferedAmount", {
      value: FLEET_EVENT_BUFFER_BYTES,
      configurable: true,
    });
    sources.get("fixture:faulty")!.send(event("fixture:faulty", 1));
    const [code] = await closed;
    assert.equal(code, 4008);
    await until(() =>
      b.frames.some(
        (f) => f.id === second && f.type === "frame" && f.frame.cursor === 1,
      ),
    );
    assert.equal(b.ws.readyState, WebSocket.OPEN);
    assert.equal(sources.get("fixture:faulty")!.readyState, WebSocket.OPEN);
    b.ws.close();
    await until(() => sources.size === 0);
  } finally {
    mux.close();
    for (const ws of browsers) ws.terminate();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
