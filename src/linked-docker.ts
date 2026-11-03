import { execFile } from "node:child_process";
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import type { EventSocket } from "./event-socket.js";

const run = promisify(execFile);
// `id` is stable across `docker compose up` recreating the container, so
// thread links and per-source send receipts survive it. `containerId` is
// the current container, still accepted for links made before this change.
export type LinkedDockerWorkspace = {
  id: string;
  name: string;
  port: number;
  containerId: string;
};
let cached: { at: number; items: LinkedDockerWorkspace[] } | undefined;
let discovering: Promise<LinkedDockerWorkspace[]> | undefined;

export function composeSourceId(project: string, service: string) {
  return createHash("sha256")
    .update(`compose:${project}/${service}`)
    .digest("hex");
}

// Only locally published, single-user Loop server containers may be linked.
// The original server keeps its database, credentials, worker and dispatches.
// Concurrent callers share one discovery, and results are reused briefly.
export async function linkedDockerWorkspaces(fresh = false) {
  if (!fresh && cached && Date.now() - cached.at < 3000) return cached.items;
  discovering ??= discover().finally(() => {
    discovering = undefined;
  });
  return discovering;
}

async function discover() {
  let ids: string[];
  try {
    const { stdout } = await run(
      "docker",
      [
        "ps",
        "--filter",
        "label=com.docker.compose.project",
        "--format",
        "{{.ID}}",
      ],
      {
        timeout: 4000,
        maxBuffer: 100000,
      },
    );
    ids = stdout
      .trim()
      .split("\n")
      .filter((id) => /^[a-f0-9]{12,64}$/.test(id))
      .slice(0, 20);
  } catch {
    return [];
  }
  const found = await Promise.all(ids.map(inspect));
  const items = found.filter((item): item is LinkedDockerWorkspace => !!item);
  cached = { at: Date.now(), items };
  return items;
}

async function inspect(id: string): Promise<LinkedDockerWorkspace | null> {
  try {
    const { stdout } = await run("docker", ["inspect", id], {
      timeout: 4000,
      maxBuffer: 2_000_000,
    });
    const container = JSON.parse(stdout)[0];
    const labels = container?.Config?.Labels || {};
    const service = labels["com.docker.compose.service"];
    const project = labels["com.docker.compose.project"];
    if (
      typeof project !== "string" ||
      !project ||
      !["app", "loop"].includes(service) ||
      !container?.State?.Running
    )
      return null;
    const published = container.NetworkSettings?.Ports?.["3000/tcp"] || [];
    const binding = published.find(
      (entry: any) => entry.HostIp === "127.0.0.1",
    );
    const port = Number(binding?.HostPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    const origin = `http://127.0.0.1:${port}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const [capabilities, auth] = await Promise.all([
        fetch(origin + "/api/capabilities", {
          signal: controller.signal,
        }).then((r) => (r.ok ? r.json() : null)),
        fetch(origin + "/api/auth-options", {
          signal: controller.signal,
        }).then((r) => (r.ok ? r.json() : null)),
      ]);
      return capabilities?.profile === "server" && auth?.mode === "single-user"
        ? {
            id: composeSourceId(project, service),
            name: `Docker · ${project}/${service}`,
            port,
            containerId: container.Id,
          }
        : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // A removed or unavailable container is not a linked workspace.
    return null;
  }
}

// Only the discovered local server decides its owner. No browser credential,
// URL, command or arbitrary header crosses this read-only source connection.
export async function connectLinkedDockerEvents(
  socket: EventSocket,
  sourceId: string,
  query: URLSearchParams,
) {
  const workspace = (await linkedDockerWorkspaces()).find(
    (item) => item.id === sourceId || item.containerId === sourceId,
  );
  if (socket.readyState !== WebSocket.OPEN) return;
  if (!workspace) {
    socket.close(1013, "Execution source unavailable");
    return;
  }
  const origin = `http://127.0.0.1:${workspace.port}`;
  const url = new URL("/api/events/ws", origin.replace("http:", "ws:"));
  for (const key of ["epoch", "cursor", "v", "clock", "projection"])
    if (query.has(key)) url.searchParams.set(key, query.get(key)!);
  const upstream = new WebSocket(url, {
    origin,
    handshakeTimeout: 10_000,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
    followRedirects: false,
  });
  upstream.on("message", (data, binary) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (binary || socket.bufferedAmount > 2 * 1024 * 1024) {
      socket.close(4008, "Reconnect for current source state");
      upstream.terminate();
    } else socket.send(data.toString());
  });
  const unavailable = () =>
    socket.close(1013, "Execution source updates unavailable");
  upstream.on("error", unavailable);
  upstream.on("close", unavailable);
  socket.once("close", () => upstream.terminate());
  socket.on("message", () => socket.close(1008, "Read-only event connection"));
}

export async function proxyLinkedDocker(
  req: IncomingMessage,
  res: ServerResponse,
  sourceId: string,
  apiPath: string,
  responsePrefix = `/api/linked/${sourceId}/`,
  current: () => void = () => {},
) {
  // Federation enrollment returns a private service credential and must only
  // be driven by the local source adapter, never through a paired browser.
  const rawPath = apiPath.split("?")[0];
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // A malformed path cannot authorize a private setup route.
  }
  if (/^mcp\/(?:federation|reverse)(?:\/|$)/i.test(decodedPath)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  // Writes reuse a discovery from the last few seconds too: re-running
  // docker on every send only delays it, and a stale port fails closed.
  const workspace = (await linkedDockerWorkspaces()).find(
    (item) => item.id === sourceId || item.containerId === sourceId,
  );
  if (!workspace) {
    res.writeHead(404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        error:
          "This Docker workspace is unavailable. Return to the laptop workspace.",
      }),
    );
    return;
  }
  const targetOrigin = `http://127.0.0.1:${workspace.port}`;
  current();
  const headers: Record<string, string> = {
    host: `127.0.0.1:${workspace.port}`,
    origin: targetOrigin,
  };
  for (const key of [
    "accept",
    "content-type",
    "content-length",
    "range",
    "if-none-match",
    "if-modified-since",
  ]) {
    const value = req.headers[key];
    if (typeof value === "string") headers[key] = value;
  }
  const upstream = httpRequest(
    targetOrigin + "/api/" + apiPath,
    { method: req.method, headers, timeout: 120000 },
    (response) => {
      const forward: Record<string, string> = { "cache-control": "no-store" };
      for (const key of [
        "content-type",
        "content-disposition",
        "content-length",
        "etag",
        "last-modified",
        "accept-ranges",
        "content-range",
        "retry-after",
        "x-loop-change-epoch",
        "x-loop-change-cursor",
        "x-loop-server-now",
        "x-loop-next-deadline",
        // The Docker server's own policy (sandbox, frame-ancestors) must
        // replace the Host page policy on proxied app and preview content.
        "content-security-policy",
      ]) {
        const value = response.headers[key];
        if (typeof value === "string") forward[key] = value;
      }
      const location = response.headers.location;
      if (location) {
        // Absolute and root-relative API redirects both stay on this source.
        forward.location = location.startsWith(targetOrigin + "/api/")
          ? responsePrefix + location.slice((targetOrigin + "/api/").length)
          : location.startsWith("/api/")
            ? responsePrefix + location.slice("/api/".length)
            : location;
      }
      res.writeHead(response.statusCode || 502, forward);
      response.pipe(res);
    },
  );
  upstream.on("timeout", () =>
    upstream.destroy(new Error("Docker workspace timed out")),
  );
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(502, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: "The Docker workspace is unavailable. No request was retried.",
        }),
      );
    }
  });
  // `aborted` is not emitted once a request body has completed, so GETs and
  // long polls cancel upstream when the client's response closes instead.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}
