process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callRoute, fetchStream } from "../src/client/workspace-api.js";
import { workspaceApi } from "../src/shared/workspace-api.js";
import { Host } from "../src/host.js";
import {
  composeSourceId,
  linkedDockerWorkspaces,
} from "../src/linked-docker.js";
import { WebSocket, WebSocketServer } from "ws";
import { until } from "./helpers.js";

const containerId = "a".repeat(64);
const options = {
  harness: "codex" as const,
  version: "fixture",
  project: "/fixture",
  billing: { mode: "existing" as const, description: "fixture" },
  capabilities: {
    approvals: true,
    questions: true,
    resume: true,
    liveAttach: false,
    terminal: false,
  },
};

test("paired gateway distinguishes Docker services and preserves their routing across container replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-linked-docker-"));
  const priorPath = process.env.PATH;
  const received: {
    path: string;
    method: string;
    body: string;
    cookie?: string;
    csrf?: string;
    origin?: string;
  }[] = [];
  const old = createServer(async (req, res) => {
    if (req.url === "/api/capabilities") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ profile: "server" }));
      return;
    }
    if (req.url === "/api/auth-options") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ mode: "single-user" }));
      return;
    }
    if (req.url === "/api/conversations/limited?resume=1") {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "12",
      });
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
    if (req.url === "/api/artifacts/a1/download") {
      res.writeHead(303, { location: "/api/artifacts/a1/file" });
      res.end();
      return;
    }
    if (req.url === "/api/artifacts/a1/file") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=fixture.bin",
      });
      res.end(Buffer.from([0, 255, 13, 10]));
      return;
    }
    if (req.url === "/api/artifacts/a1/app") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy":
          "sandbox allow-scripts; frame-ancestors 'self'",
      });
      res.end("<p>app</p>");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      path: req.url || "",
      method: req.method || "",
      body: Buffer.concat(chunks).toString(),
      cookie: req.headers.cookie,
      csrf: req.headers["x-loop-csrf"] as string | undefined,
      origin: req.headers.origin,
    });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ owner: "old-docker", conversations: ["old-thread"] }),
    );
  });
  const secondId = "b".repeat(64);
  const second = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/capabilities"
          ? { profile: "server" }
          : req.url === "/api/auth-options"
            ? { mode: "single-user" }
            : { owner: "second-docker", conversations: ["second-thread"] },
      ),
    );
  });
  let host: Host | undefined;
  const live = new WebSocketServer({ server: old });
  const eventRequests: {
    url?: string;
    headers: import("node:http").IncomingHttpHeaders;
  }[] = [];
  const clients: WebSocket[] = [];
  live.on("connection", (socket, req) => {
    eventRequests.push({ url: req.url, headers: req.headers });
    socket.send(
      JSON.stringify({
        v: 2,
        type: "reset",
        epoch: "docker-source",
        cursor: 7,
      }),
    );
  });
  try {
    await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) =>
      second.listen(0, "127.0.0.1", resolve),
    );
    const port = (old.address() as { port: number }).port;
    const secondPort = (second.address() as { port: number }).port;
    const inspect = [
      {
        Id: containerId,
        Config: {
          Labels: {
            "com.docker.compose.project": "fresh-workspace",
            "com.docker.compose.service": "app",
          },
        },
        State: { Running: true },
        NetworkSettings: {
          Ports: {
            "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }],
          },
        },
      },
    ];
    const secondInspect = JSON.parse(JSON.stringify(inspect));
    secondInspect[0].Id = secondId;
    secondInspect[0].Config.Labels["com.docker.compose.service"] = "loop";
    secondInspect[0].NetworkSettings.Ports["3000/tcp"][0].HostPort =
      String(secondPort);
    await writeFile(join(dir, containerId + ".json"), JSON.stringify(inspect));
    await writeFile(
      join(dir, secondId + ".json"),
      JSON.stringify(secondInspect),
    );
    await writeFile(join(dir, "ids"), `${containerId}\n${secondId}\n`);
    const docker = join(dir, "docker");
    await writeFile(
      docker,
      `#!/bin/sh\nif [ "$1" = ps ]; then cat '${join(dir, "ids")}'; else cat '${dir}/'"$2"'.json'; fi\n`,
    );
    await chmod(docker, 0o755);
    process.env.PATH = dir + ":" + (priorPath || "");
    host = new Host(dir, options);
    host.workspace = {
      http: (_req, res) => {
        res.writeHead(200);
        res.end("{}");
      },
      status: () => ({}),
      admin: async () => ({}),
      connect: () => () => {},
      originChanged: () => {},
    };
    await host.listen();
    const secret = new URL(host.pair().url).hash.slice(6);
    const paired = await fetch(host.origin + "/pair", {
      method: "POST",
      headers: { origin: host.origin, "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const csrf = (
      (await fetch(host.origin + "/session", { headers: { cookie } }).then(
        (r) => r.json(),
      )) as any
    ).csrf;
    assert.equal(
      (await fetch(host.origin + "/api/linked-workspaces")).status,
      401,
    );
    const found = await fetch(host.origin + "/api/linked-workspaces", {
      headers: { cookie },
    }).then((r) => r.json());
    // The source id survives `docker compose up` recreating the container.
    const sourceId = composeSourceId("fresh-workspace", "app");
    const secondSourceId = composeSourceId("fresh-workspace", "loop");
    assert.deepEqual(found, [
      { id: sourceId, name: "Docker · fresh-workspace/app" },
      { id: secondSourceId, name: "Docker · fresh-workspace/loop" },
    ]);
    assert.equal((await fetch(host.origin + "/api/agent-sources")).status, 401);
    const sources = await fetch(host.origin + "/api/agent-sources", {
      headers: { cookie },
    }).then((r) => r.json());
    assert.deepEqual(sources, [
      {
        id: `docker:${sourceId}`,
        name: "Docker · fresh-workspace/app",
        kind: "docker",
      },
      {
        id: `docker:${secondSourceId}`,
        name: "Docker · fresh-workspace/loop",
        kind: "docker",
      },
    ]);
    assert.deepEqual(
      await fetch(
        host.origin +
          `/api/agent-sources/docker%3A${secondSourceId}/conversations`,
        {
          headers: { cookie },
        },
      ).then((r) => r.json()),
      { owner: "second-docker", conversations: ["second-thread"] },
    );
    const unknown = await fetch(
      host.origin + "/api/agent-sources/cloud%3Aunregistered/runs",
      {
        headers: { cookie },
      },
    );
    assert.equal(unknown.status, 404);
    assert.equal(received.length, 0);
    for (const prefix of [
      `/api/agent-sources/docker%3A${sourceId}/`,
      `/api/linked/${sourceId}/`,
    ]) {
      for (const privatePath of [
        "mcp/federation/enroll",
        "MCP/FEDERATION/enroll",
        "mcp%2Ffederation%2Fenroll",
        "mcp/reverse",
      ]) {
        const blocked: Response = await fetch(
          host.origin + prefix + privatePath,
          {
            headers: { cookie },
          },
        );
        assert.equal(blocked.status, 404);
        assert.equal(received.length, 0);
      }
    }
    const base = host.origin + `/api/agent-sources/docker%3A${sourceId}/`;
    const ws = new WebSocket(
      base.replace("http:", "ws:") +
        "events/ws?epoch=old&cursor=3&owner=untrusted",
      {
        headers: { cookie, origin: host.origin, "x-loop-csrf": csrf },
      },
    );
    clients.push(ws);
    const frames: any[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await until(() => frames.length === 1);
    assert.equal(frames[0].epoch, "docker-source");
    assert.equal(eventRequests[0].url, "/api/events/ws?epoch=old&cursor=3");
    assert.equal(eventRequests[0].headers.origin, `http://127.0.0.1:${port}`);
    assert.equal(eventRequests[0].headers.cookie, undefined);
    assert.equal(eventRequests[0].headers.authorization, undefined);
    assert.equal(eventRequests[0].headers["x-loop-csrf"], undefined);
    for (const headers of [
      { origin: host.origin },
      { cookie, origin: "https://elsewhere.example" },
      { cookie, origin: host.origin, authorization: "Bearer scoped-card" },
    ]) {
      const rejected = new WebSocket(
        base.replace("http:", "ws:") + "events/ws",
        { headers },
      );
      clients.push(rejected);
      rejected.on("error", () => {});
      await new Promise<void>((resolve) =>
        rejected.on("unexpected-response", (_req, res) => {
          assert.equal(res.statusCode, 403);
          res.resume();
          rejected.terminate();
          resolve();
        }),
      );
    }
    assert.equal(
      eventRequests.length,
      1,
      "rejected clients never reach the source",
    );
    ws.send(
      JSON.stringify({ type: "prompt", text: "not a command transport" }),
    );
    await until(() => ws.readyState === WebSocket.CLOSED);
    // Root-relative redirects stay on this source, not the paired laptop.
    const redirect = await fetch(base + "artifacts/a1/download", {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(
      redirect.headers.get("location"),
      `/api/agent-sources/docker%3A${sourceId}/artifacts/a1/file`,
    );
    // Exercise the production typed client through the paired source proxy,
    // including its rewritten binary redirect and attachment headers.
    const originalFetch = globalThis.fetch;
    const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const hostOrigin = host.origin;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: hostOrigin + "/", search: "" },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: new EventTarget(),
    });
    globalThis.fetch = (input, init) =>
      originalFetch(new URL(String(input), hostOrigin), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie },
      });
    try {
      const blob = await callRoute(
        workspaceApi.artifactDownload,
        { params: { id: "a1" } },
        `docker:${sourceId}`,
      );
      assert.deepEqual(
        Buffer.from(await blob.arrayBuffer()),
        Buffer.from([0, 255, 13, 10]),
      );
      const file = await fetchStream(
        workspaceApi.artifactFile,
        { params: { id: "a1" } },
        `docker:${sourceId}`,
      );
      assert.equal(
        file.headers.get("content-disposition"),
        "attachment; filename=fixture.bin",
      );
      assert.deepEqual(
        Buffer.from(await file.arrayBuffer()),
        Buffer.from([0, 255, 13, 10]),
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (oldLocation)
        Object.defineProperty(globalThis, "location", oldLocation);
      else Reflect.deleteProperty(globalThis, "location");
      if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
    // The Docker server's own policy replaces the Host page policy.
    const app = await fetch(base + "artifacts/a1/app", { headers: { cookie } });
    assert.equal(
      app.headers.get("content-security-policy"),
      "sandbox allow-scripts; frame-ancestors 'self'",
    );
    for (const prefix of [base, host.origin + `/api/linked/${sourceId}/`]) {
      const limited = await fetch(prefix + "conversations/limited?resume=1", {
        headers: { cookie },
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "12");
      assert.deepEqual(await limited.json(), { error: "Too many requests" });
    }
    // Links made with the container id before stable ids still resolve.
    assert.equal(
      (
        await fetch(
          host.origin +
            `/api/agent-sources/docker%3A${containerId}/artifacts/a1/app`,
          { headers: { cookie } },
        )
      ).status,
      200,
    );
    const endpoint = base + "runs";
    const denied = await fetch(endpoint, {
      method: "POST",
      headers: {
        cookie,
        origin: host.origin,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    assert.equal(received.length, 0);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        cookie,
        origin: host.origin,
        "x-loop-csrf": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "old-agent",
        conversationId: "old-thread",
        input: "Continue",
        idempotencyKey: "test-receipt",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      owner: "old-docker",
      conversations: ["old-thread"],
    });
    assert.deepEqual(received, [
      {
        path: "/api/runs",
        method: "POST",
        body: '{"agentId":"old-agent","conversationId":"old-thread","input":"Continue","idempotencyKey":"test-receipt"}',
        cookie: undefined,
        csrf: undefined,
        origin: `http://127.0.0.1:${port}`,
      },
    ]);
    const replacementId = "c".repeat(64);
    inspect[0].Id = replacementId;
    await writeFile(
      join(dir, replacementId + ".json"),
      JSON.stringify(inspect),
    );
    await writeFile(join(dir, "ids"), `${replacementId}\n${secondId}\n`);
    const refreshed = await linkedDockerWorkspaces(true);
    assert.deepEqual(
      refreshed.map(({ id, name }) => ({ id, name })),
      found,
    );
    assert.equal(refreshed[0].containerId, replacementId);
    assert.deepEqual(
      await fetch(base + "conversations", { headers: { cookie } }).then((r) =>
        r.json(),
      ),
      {
        owner: "old-docker",
        conversations: ["old-thread"],
      },
    );
  } finally {
    process.env.PATH = priorPath;
    clients.forEach((socket) => socket.terminate());
    live.clients.forEach((socket) => socket.terminate());
    live.close();
    if (host) await host.close();
    await new Promise<void>((resolve) => old.close(() => resolve()));
    await new Promise<void>((resolve) => second.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
