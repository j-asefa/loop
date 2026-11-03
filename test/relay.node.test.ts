import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { Relay } from "../src/relay.js";
import { until } from "./helpers.js";

/** A POST through the relay, with its outcome header. */
function post(port: number, path = "/api/send") {
  return new Promise<{ status: number; outcome?: string }>(
    (resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, method: "POST", path },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              outcome: res.headers["x-loop-outcome"] as string | undefined,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end("{}");
    },
  );
}

test("the relay never pools a connection to the application", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-relay-"));
  const socket = join(dir, "app.sock");
  let served = 0;
  let connections = 0;
  // An application that answers and then hangs up, as one does when its
  // keep-alive idle timeout expires. A pooled socket would be handed back for
  // the next request and reset before anything handled it -- indistinguishable
  // from a reset where the application had already acted, so it would be
  // reported as an unknown outcome and send someone to check a send that never
  // happened.
  const app = createServer((req, res) => {
    served++;
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  app.on("connection", () => connections++);
  await new Promise<void>((r) => app.listen(socket, r));
  const relay = new Relay(200);
  await relay.listen("127.0.0.1");
  relay.setBackend({ generation: 1, path: socket });
  try {
    for (let i = 1; i <= 4; i++) {
      const answer = await post(relay.port);
      assert.equal(answer.status, 200, `request ${i} was not served`);
      assert.equal(answer.outcome, undefined);
    }
    assert.equal(served, 4);
    // The application holds every connection open, so a pooling relay would
    // reuse one. Each request opening its own is what makes it impossible to
    // send over a socket the application has since closed.
    assert.equal(connections, 4, "a connection to the application was pooled");
  } finally {
    await relay.close();
    await new Promise<void>((r) => app.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a mutation the application already received is still reported as unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-relay-unknown-"));
  const socket = join(dir, "app.sock");
  let received = 0;
  // The application takes the request and dies before answering: it may have
  // acted on it, so this one must never be reported as safe to retry.
  const app = createServer((req) => {
    received++;
    req.resume();
    req.on("end", () => req.socket.destroy());
  });
  await new Promise<void>((r) => app.listen(socket, r));
  const relay = new Relay(200);
  await relay.listen("127.0.0.1");
  relay.setBackend({ generation: 1, path: socket });
  try {
    const answer = await post(relay.port);
    assert.equal(received, 1);
    assert.equal(answer.status, 502);
    assert.equal(answer.outcome, "unknown");
  } finally {
    await relay.close();
    await new Promise<void>((r) => app.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a launch that recovers on its own generation keeps its live sockets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-relay-ws-"));
  const socket = join(dir, "app.sock");
  const app = createServer();
  const sockets = new WebSocketServer({ server: app });
  sockets.on("connection", (ws) => ws.send("hello"));
  await new Promise<void>((r) => app.listen(socket, r));
  const relay = new Relay(200);
  await relay.listen("127.0.0.1");
  relay.setBackend({ generation: 1, path: socket });
  const live = new WebSocket(`ws://127.0.0.1:${relay.port}/stream`);
  try {
    await new Promise<void>((r, reject) => {
      live.once("message", () => r());
      live.once("error", reject);
    });

    // A missed heartbeat detaches the launch; the same launch proves its
    // socket again two beats later. That is one launch recovering, not a new
    // one taking over, so the drain armed at the detach must be called off.
    relay.setBackend(undefined);
    await new Promise((r) => setTimeout(r, 60));
    relay.setBackend({ generation: 1, path: socket });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      live.readyState,
      WebSocket.OPEN,
      "a recovered launch lost the stream it was still serving",
    );

    // A genuinely new launch does take over, and the old stream drains.
    relay.setBackend({ generation: 2, path: socket });
    await until(() => live.readyState === WebSocket.CLOSED);
  } finally {
    live.close();
    await relay.close();
    sockets.close();
    await new Promise<void>((r) => app.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
