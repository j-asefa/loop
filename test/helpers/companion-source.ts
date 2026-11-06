import { request } from "node:http";
import { WebSocket } from "ws";
import type { SourceAdapter } from "../../src/agent-sources.js";

export type CompanionSourceFixture = { origin: string; cookie: string };

/** Test-only transport between independently paired companions. This exercises
 * source routing/multiplexing, not fleet enrollment. The destination and its
 * credential arrive over fixture IPC, never from the browser.
 */
export function companionSourceFixture({
  origin,
  cookie,
}: CompanionSourceFixture): SourceAdapter {
  const admit = (id: string) => {
    if (id !== "remote") throw new Error("Unknown fixture companion");
  };
  return {
    kind: "fixture",
    discover: async () => [{ id: "remote", name: "Remote companion" }],
    events: async (socket, id, query) => {
      admit(id);
      const url = new URL("/api/events/ws", origin.replace("http:", "ws:"));
      for (const key of ["epoch", "cursor", "v", "clock", "projection"])
        if (query.has(key)) url.searchParams.set(key, query.get(key)!);
      const upstream = new WebSocket(url, {
        headers: { origin, cookie },
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
      });
      upstream.on("message", (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data.toString());
      });
      upstream.on("error", () => socket.close(1013, "Fixture unavailable"));
      upstream.on("close", () => socket.close(1013, "Fixture disconnected"));
      socket.once("close", () => upstream.terminate());
    },
    proxy: async (req, res, id, apiPath, prefix, current) => {
      admit(id);
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      current();
      const upstream = request(
        origin + "/api/" + apiPath,
        { method: req.method, headers: { origin, cookie }, timeout: 10_000 },
        (response) => {
          const headers: Record<string, string> = {};
          for (const key of [
            "content-type",
            "cache-control",
            "x-loop-change-epoch",
            "x-loop-change-cursor",
            "x-loop-server-now",
            "x-loop-next-deadline",
          ]) {
            const value = response.headers[key];
            if (typeof value === "string") headers[key] = value;
          }
          const location = response.headers.location;
          if (location?.startsWith("/api/"))
            headers.location = prefix + location.slice("/api/".length);
          res.writeHead(response.statusCode ?? 502, headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.on("timeout", () => upstream.destroy());
      res.once("close", () => upstream.destroy());
      upstream.end();
    },
  };
}
