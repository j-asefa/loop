import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { installEventSockets } from "../src/server/event-sockets";
// Server-profile behaviour, removed with the server profile (fresh start PR 3).
// Awaited so the profile and a private data directory are set before any
// imported module opens the database.
const dataDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.LOOP_PROFILE = "server";
  const dir = mkdtempSync(join(tmpdir(), "loop-event-sockets-"));
  process.env.LOOP_DATA_DIR = dir;
  return dir;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const { session, connectEvents } = vi.hoisted(() => ({
  session: vi.fn(),
  connectEvents: vi.fn(() => () => {}),
}));
vi.mock("../src/server/access", () => ({
  allowedOrigin: () => true,
  workspaceSession: session,
}));
vi.mock("../src/server/workspace-events", () => ({
  connectWorkspaceEvents: connectEvents,
}));
beforeEach(() => {
  session.mockReset();
  connectEvents.mockClear();
});
afterEach(() => vi.useRealTimers());

const refuseToken = () => {
  throw new Error("Browser socket fixture has no integration tokens");
};

it("retries session lookup failures while reserving expiry for confirmed revocation", async () => {
  // The actual HTTP upgrade and heartbeat run with an injected session-store
  // failure. Only intervals are advanced; socket I/O keeps real timers.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const identity = { user: { id: "owner" } };
  session.mockResolvedValue(identity);
  const server = createServer();
  installEventSockets(server, refuseToken);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events/ws`);
    await once(socket, "open");
    return socket;
  };
  try {
    const socket = await connect();
    session.mockRejectedValueOnce(
      new Error("Session store temporarily unavailable"),
    );
    const failed = once(socket, "close");
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await failed)[0]).toBe(1011);

    const recovered = await connect();
    session.mockResolvedValueOnce(null);
    const revoked = once(recovered, "close");
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await revoked)[0]).toBe(4003);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("closes established and pending sockets and refuses late authentication after shutdown", async () => {
  const identity = { user: { id: "owner" } };
  session.mockResolvedValue(identity);
  const server = createServer();
  installEventSockets(server, refuseToken);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const address = `ws://127.0.0.1:${port}/api/events/ws`;
  const established = new WebSocket(address);
  await once(established, "open");
  let finish!: (value: typeof identity) => void;
  let started!: () => void;
  const awaitingSession = new Promise<void>((resolve) => {
    started = resolve;
  });
  session.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = new WebSocket(address);
  pending.on("error", () => {});
  try {
    await awaitingSession;
    const shutdown = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    await expect
      .poll(() => [established.readyState, pending.readyState])
      .toEqual([WebSocket.CLOSED, WebSocket.CLOSED]);
    finish(identity);
    await shutdown;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(connectEvents).toHaveBeenCalledTimes(1);
  } finally {
    finish?.(identity);
    established.terminate();
    pending.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("releases upgrade capacity after stalled authentication sockets time out", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const identity = { user: { id: "owner" } };
  const finish: ((value: typeof identity) => void)[] = [];
  session.mockImplementation(
    () => new Promise((resolve) => finish.push(resolve)),
  );
  const server = createServer();
  installEventSockets(server, refuseToken);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  const connect = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events/ws`);
    socket.on("error", () => {});
    sockets.push(socket);
    return socket;
  };
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!condition()) {
      if (performance.now() > deadline)
        throw new Error("Socket fixture timed out");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  try {
    for (let i = 0; i < 256; i++) connect();
    await until(() => finish.length === 256);
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() =>
      sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
    );
    session.mockResolvedValue(identity);
    const recovered = connect();
    await once(recovered, "open");
    expect(connectEvents).toHaveBeenCalledTimes(1);
  } finally {
    finish.forEach((resolve) => resolve(identity));
    sockets.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
