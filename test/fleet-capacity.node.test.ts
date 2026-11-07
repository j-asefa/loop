import { createHost } from "./helpers/gateway.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { Response, type fetch as undiciFetch } from "undici";
import { WebSocket, WebSocketServer } from "ws";

const dir = mkdtempSync(join(tmpdir(), "loop-fleet-capacity-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { Host } = await import("../src/host.js");
const { FleetCapacity } = await import("../src/server/fleet-capacity.js");
const { FleetWorkspaceHttpTransport } =
  await import("../src/server/fleet-workspace-http.js");
const origin = "https://gateway.example";
let fleet = true;
const capacity = new FleetCapacity(() => fleet);
const host = createHost(dir);
const held = new Set<ServerResponse>();
const sockets = new Set<WebSocket>();
const requests = new Set<ClientRequest>();
let invoked = 0;
let tokenUpgrades = 0;
const tokenSockets = new WebSocketServer({ noServer: true });
// Handlers intentionally hold IO; their authentication and semantics have
// separate tests. This exercises the production Host admission before dispatch.
const hold = (_req: unknown, res: ServerResponse) => {
  invoked++;
  held.add(res);
  res.once("close", () => held.delete(res));
};
host.workspace = {
  http: hold,
  peerHttp: hold,
  fleetCapacity: capacity,
  tokenEvents: {
    upgrade: (req, socket, head, admit) => {
      if (!admit()) return;
      tokenUpgrades++;
      tokenSockets.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => ws.terminate());
      });
    },
    close: () => {
      for (const ws of tokenSockets.clients) ws.terminate();
      tokenSockets.close();
    },
  },
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
let cookie = "";
function http(path: string, body?: unknown) {
  const result = new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: any;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: new URL(origin).host,
          ...(path.startsWith("/api/fleet/peer/") ? {} : { origin, cookie }),
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    requests.add(req);
    req.once("close", () => requests.delete(req));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // Requests deliberately remain pending until the fixture releases them.
  void result.catch(() => {});
  return result;
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Fixture admission did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function socket(path = "/api/events/ws") {
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}${path}`, {
    headers: {
      host: new URL(origin).host,
      origin,
      ...(path === "/api/events/stream"
        ? { authorization: "Bearer fixture" }
        : { cookie }),
    },
  });
  sockets.add(ws);
  ws.once("close", () => sockets.delete(ws));
  await once(ws, "open");
  return ws;
}
function refusedTokenUpgrade() {
  return new Promise<{ status: number; retryAfter?: string }>(
    (resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${host.port}/api/events/stream`,
        {
          headers: {
            host: new URL(origin).host,
            authorization: "Bearer fixture",
          },
        },
      );
      sockets.add(ws);
      ws.once("close", () => sockets.delete(ws));
      ws.on("error", reject);
      ws.once("open", () => {
        ws.terminate();
        reject(new Error("Busy token upgrade was unexpectedly admitted"));
      });
      ws.once("unexpected-response", (_req, res) => {
        res.resume();
        resolve({
          status: res.statusCode!,
          retryAfter: res.headers["retry-after"],
        });
        ws.terminate();
      });
    },
  );
}
async function releaseHeld() {
  for (const res of held) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }
  await waitFor(() => held.size === 0);
}

test("one gateway budgets HTTP, sockets and every peer sender together", async (t) => {
  const started = performance.now();
  const memoryBefore = process.memoryUsage();
  const observations: Record<string, unknown> = {};
  const controllers: AbortController[] = [];
  try {
    await host.listen();
    host.setOrigin(origin);
    const link = new URL(host.pair().url);
    const paired = await http("/pair", {
      secret: new URLSearchParams(link.hash.slice(1)).get("pair"),
      name: "Fixture",
    });
    assert.equal(paired.status, 200);
    cookie = paired.headers["set-cookie"]![0].split(";")[0];
    await waitFor(() => capacity.snapshot().total === 0);
    let contacted = 0;
    const fetcher: typeof undiciFetch = async (_url, init) => {
      contacted++;
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error("Fixture closed"));
        init!.signal!.addEventListener("abort", abort, { once: true });
        if (init!.signal!.aborted) abort();
      });
    };
    const transport = new FleetWorkspaceHttpTransport(fetcher, capacity);
    const catalog = {
      version: 1 as const,
      requestId: randomUUID(),
      credential: randomBytes(32).toString("base64url"),
    };
    const outbound: Promise<unknown>[] = [];
    const earlyFailures: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      outbound.push(
        transport
          .catalog("https://destination.example", catalog, controller.signal)
          .catch((error) => {
            earlyFailures.push(error);
            return error;
          }),
      );
    }
    await waitFor(() => contacted === 4 || earlyFailures.length > 0);
    assert.deepEqual(earlyFailures, []);
    await assert.rejects(
      transport.catalog(
        "https://destination.example",
        catalog,
        new AbortController().signal,
      ),
      /connections are busy/,
    );
    assert.equal(contacted, 4, "Capacity refusal must precede network IO");
    const ws = await socket();
    assert.equal(capacity.snapshot().browser, 1);
    // Different endpoints and simulated senders cannot get separate budgets.
    const peerRequests = Array.from({ length: 64 }, (_, i) =>
      http("/api/fleet/peer/v1/fixture/" + i, { sender: i % 8 }),
    );
    await waitFor(() => held.size === 64);
    const overflow = await http("/api/fleet/peer/v1/fixture/overflow", {});
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers["retry-after"], "1");
    assert.equal(overflow.headers["x-loop-fleet-available"], "0");
    assert.equal(invoked, 64);
    // 91 HTTP requests plus the open socket borrow well beyond the 32 reserved
    // browser slots, up to the same 160-operation budget as peer/outbound IO.
    const browserRequests = Array.from({ length: 91 }, () =>
      http("/api/fixture"),
    );
    await waitFor(() => held.size === 155);
    assert.deepEqual(capacity.snapshot(), {
      enabled: true,
      browser: 92,
      peer: 64,
      outbound: 4,
      total: 160,
    });
    observations.loaded = capacity.snapshot();
    observations.simulatedPeerSenders = 8;
    observations.heldHttpRequests = held.size;
    observations.browserSockets = sockets.size;
    const busy = await http("/api/fixture");
    assert.equal(busy.status, 503);
    assert.equal(invoked, 155);
    observations.peerOverflowStatus = overflow.status;
    observations.browserOverflowStatus = busy.status;
    observations.retryAfter = overflow.headers["retry-after"];
    const closed = once(ws, "close");
    ws.close();
    await closed;
    await waitFor(() => capacity.snapshot().total === 159);
    const borrowed = http("/api/fixture");
    await waitFor(() => held.size === 156);
    assert.equal(capacity.snapshot().browser, 92);
    assert.equal(capacity.snapshot().total, 160);
    for (const controller of controllers) controller.abort();
    await Promise.all(outbound);
    await waitFor(() => capacity.snapshot().outbound === 0);
    await releaseHeld();
    await Promise.all([...peerRequests, ...browserRequests, borrowed]);
    await waitFor(() => capacity.snapshot().total === 0);
    assert.equal(capacity.availablePeers(), 64);
    observations.afterRelease = capacity.snapshot();

    await t.test(
      "token sockets share capacity and release it on disconnect",
      async () => {
        const ws = await socket("/api/events/stream");
        assert.equal(capacity.snapshot().browser, 1);
        assert.equal(tokenUpgrades, 1);
        const pending = Array.from({ length: 159 }, () => http("/api/fixture"));
        await waitFor(() => held.size === 159);
        assert.equal(capacity.snapshot().total, 160);
        assert.deepEqual(await refusedTokenUpgrade(), {
          status: 503,
          retryAfter: "1",
        });
        assert.equal(
          tokenUpgrades,
          1,
          "Refusal must precede token socket dispatch",
        );
        const closed = once(ws, "close");
        ws.close();
        await closed;
        await waitFor(() => capacity.snapshot().total === 159);
        const replacement = await socket("/api/events/stream");
        assert.equal(tokenUpgrades, 2);
        assert.equal(capacity.snapshot().total, 160);
        const replacementClosed = once(replacement, "close");
        replacement.close();
        await replacementClosed;
        await releaseHeld();
        await Promise.all(pending);
        await waitFor(() => capacity.snapshot().total === 0);
      },
    );

    await t.test(
      "peer Retry-After is shared by independent transports without resubmission",
      async () => {
        const budget = new FleetCapacity(() => true);
        let calls = 0;
        const busy: typeof undiciFetch = async () => {
          calls++;
          return new Response(null, {
            status: 503,
            headers: { "retry-after": "30" },
          });
        };
        const one = new FleetWorkspaceHttpTransport(busy, budget);
        const two = new FleetWorkspaceHttpTransport(busy, budget);
        await assert.rejects(
          one.catalog(
            "https://busy.example",
            catalog,
            new AbortController().signal,
          ),
          (error: any) => error.diagnostic?.retryAfterMs === 30_000,
        );
        await assert.rejects(
          two.catalog(
            "https://busy.example",
            catalog,
            new AbortController().signal,
          ),
          (error: any) => error.diagnostic?.retryAfterMs > 29_000,
        );
        assert.equal(
          calls,
          1,
          "A throttled transport must not send another request",
        );
        assert.equal(budget.snapshot().outbound, 0);
        await assert.rejects(
          two.catalog(
            "https://healthy.example",
            catalog,
            new AbortController().signal,
          ),
        );
        assert.equal(calls, 2, "One destination must not throttle another");
      },
    );

    await t.test(
      "the fleet of one retains browser admission above the federation ceiling",
      async () => {
        fleet = false;
        const pending = Array.from({ length: 170 }, () => http("/api/fixture"));
        await waitFor(() => held.size === 170);
        assert.equal(capacity.snapshot().browser, 170);
        observations.standaloneBrowserRequests = capacity.snapshot().browser;
        const token = await socket("/api/events/stream");
        assert.equal(capacity.snapshot().browser, 171);
        const tokenClosed = once(token, "close");
        token.close();
        await tokenClosed;
        await waitFor(() => capacity.snapshot().browser === 170);
        // New peer work sheds first; it cannot displace any accepted browser IO.
        assert.equal(
          (await http("/api/fleet/peer/v1/fixture/overloaded", {})).status,
          503,
        );
        assert.equal(held.size, 170);
        await releaseHeld();
        await Promise.all(pending);
        await waitFor(() => capacity.snapshot().total === 0);
        fleet = true;
      },
    );
    await t.test(
      "disconnect releases the slot once without dispatching a replacement",
      async () => {
        const count = invoked;
        const pending = http("/api/fixture");
        await waitFor(() => held.size === 1);
        for (const req of requests) req.destroy();
        await assert.rejects(pending);
        await waitFor(() => capacity.snapshot().total === 0);
        assert.equal(invoked, count + 1);
      },
    );
    t.diagnostic(
      "FLEET_METRIC " +
        JSON.stringify({
          boundary:
            "production Host admission on one simulated receiving tunnel",
          ...observations,
          milliseconds: Math.round(performance.now() - started),
          rssBefore: memoryBefore.rss,
          rssAfter: process.memoryUsage().rss,
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
          limitations:
            "Authentication and provider semantics are covered separately; RSS is observed, not a memory-bound proof.",
        }),
    );
  } finally {
    for (const controller of controllers) controller.abort();
    for (const req of requests) req.destroy();
    for (const res of held) res.destroy();
    for (const ws of sockets) ws.terminate();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
