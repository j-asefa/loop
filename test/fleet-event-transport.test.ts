import { expect, it, vi } from "vitest";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { Response, type fetch as undiciFetch } from "undici";
import { FleetCapacity } from "../src/server/fleet-capacity.js";
import { FleetWorkspaceHttpTransport } from "../src/server/fleet-workspace-http.js";
import { FleetWorkspaceEventHttpTransport } from "../src/server/fleet-workspace-event-http.js";
import { publicNetworkLookup } from "../src/server/mcp/network.js";
import { FLEET_EVENTS_PATH } from "../src/shared/fleet-workspace-events.js";
import { until } from "./helpers.js";

it("reserves outbound HTTP capacity while sharing bounded event sockets", async () => {
  const capacity = new FleetCapacity(() => true);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const controllers: AbortController[] = [];
  const clients: WebSocket[] = [];
  const token = randomBytes(32).toString("base64url");
  const headers: unknown[] = [];
  const pendingHttp: (() => void)[] = [];
  const fetcher: typeof undiciFetch = () =>
    new Promise((resolve) =>
      pendingHttp.push(() => resolve(new Response(null, { status: 403 }))),
    );
  server.on("connection", (_socket, request) => headers.push(request.headers));
  // Only the socket destination changes for loopback IO. Inspect the production
  // public-DNS lookup and handshake options before creating each real socket.
  const transport = new FleetWorkspaceEventHttpTransport(
    fetcher,
    capacity,
    (url, options) => {
      expect(url.protocol).toBe("wss:");
      expect(url.pathname).toBe(FLEET_EVENTS_PATH);
      expect(options.lookup).toBe(publicNetworkLookup);
      expect(options.followRedirects).toBe(false);
      expect(options.perMessageDeflate).toBe(false);
      const ws = new WebSocket(
        `ws://127.0.0.1:${address.port}${url.pathname}`,
        { ...options, lookup: undefined },
      );
      clients.push(ws);
      return ws;
    },
  );
  try {
    const connect = async (origin: string) => {
      const controller = new AbortController();
      controllers.push(controller);
      await transport.connect(origin, token, controller.signal);
    };
    await connect("https://source.example");
    expect(capacity.snapshot().outbound).toBe(1);
    expect(headers).toHaveLength(1);
    for (const header of headers)
      expect(header).toMatchObject({
        authorization: `Bearer ${token}`,
        "x-loop55-fleet-version": "1",
      });
    await expect(
      transport.connect(
        "https://source.example",
        token,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(clients).toHaveLength(1);
    const catalog = () =>
      transport.catalog(
        "https://source.example",
        { version: 1, requestId: randomUUID(), credential: token },
        new AbortController().signal,
      );
    const requests = Array.from({ length: 3 }, () =>
      catalog().catch((error: unknown) => error),
    );
    await until(() => pendingHttp.length === 3);
    expect(capacity.snapshot().outbound).toBe(4);
    await expect(catalog()).rejects.toMatchObject({ status: 503 });
    expect(pendingHttp).toHaveLength(3);
    for (const resolve of pendingHttp.splice(0)) resolve();
    for (const result of await Promise.all(requests))
      expect(result).toMatchObject({ status: 403 });
    expect(capacity.snapshot().outbound).toBe(1);
    // Event traffic also leaves aggregate capacity for another HTTP exchange.
    for (let i = 1; i < 24; i++) await connect(`https://source-${i}.example`);
    expect(capacity.snapshot().outbound).toBe(24);
    await expect(connect("https://overflow.example")).rejects.toMatchObject({
      status: 503,
    });
    expect(clients).toHaveLength(24);
    const lastHttp = catalog().catch((error: unknown) => error);
    await until(() => pendingHttp.length === 1);
    expect(capacity.snapshot().outbound).toBe(25);
    pendingHttp.pop()!();
    expect(await lastHttp).toMatchObject({ status: 403 });
    for (const controller of controllers) controller.abort();
    await until(() => capacity.snapshot().outbound === 0);
    expect(capacity.snapshot().total).toBe(0);
    await connect("https://source.example");
    expect(capacity.snapshot().outbound).toBe(1);
  } finally {
    for (const resolve of pendingHttp.splice(0)) resolve();
    for (const controller of controllers) controller.abort();
    for (const ws of clients) ws.terminate();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("honors peer HTTP backpressure without replaying or holding the failed request", async () => {
  const capacity = new FleetCapacity(() => true);
  const fetcher: typeof undiciFetch = vi.fn(
    async () =>
      new Response("unavailable", {
        status: 503,
        headers: { "Retry-After": "5" },
      }),
  );
  const transport = new FleetWorkspaceHttpTransport(fetcher, capacity);
  const input = {
    version: 1 as const,
    requestId: randomUUID(),
    credential: randomBytes(32).toString("base64url"),
  };
  await expect(
    transport.catalog(
      "https://source.example",
      input,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 502, diagnostic: { retryAfterMs: 5000 } });
  expect(capacity.snapshot().total).toBe(0);
  await expect(
    transport.catalog(
      "https://source.example",
      input,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
