process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../src/host.js";
import { composeSourceId } from "../src/linked-docker.js";

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

test("paired gateway discovers a local Docker workspace and forwards its conversation writes only to that server", async () => {
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
    if (req.url === "/api/artifacts/a1/download") {
      res.writeHead(303, { location: "/api/artifacts/a1/file" });
      res.end();
      return;
    }
    if (req.url === "/api/artifacts/a1/app") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
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
  let host: Host | undefined;
  try {
    await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
    const port = (old.address() as { port: number }).port;
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
    await writeFile(join(dir, "inspect.json"), JSON.stringify(inspect));
    const docker = join(dir, "docker");
    await writeFile(
      docker,
      `#!/bin/sh\nif [ "$1" = ps ]; then echo ${containerId}; else cat '${join(dir, "inspect.json")}'; fi\n`,
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
    assert.deepEqual(found, [
      { id: sourceId, name: "Docker · fresh-workspace" },
    ]);
    assert.equal((await fetch(host.origin + "/api/agent-sources")).status, 401);
    const sources = await fetch(host.origin + "/api/agent-sources", {
      headers: { cookie },
    }).then((r) => r.json());
    assert.deepEqual(sources, [
      {
        id: `docker:${sourceId}`,
        name: "Docker · fresh-workspace",
        kind: "docker",
      },
    ]);
    const unknown = await fetch(
      host.origin + "/api/agent-sources/cloud%3Aunregistered/runs",
      {
        headers: { cookie },
      },
    );
    assert.equal(unknown.status, 404);
    assert.equal(received.length, 0);
    const base = host.origin + `/api/agent-sources/docker%3A${sourceId}/`;
    // Root-relative redirects stay on this source, not the paired laptop.
    const redirect = await fetch(base + "artifacts/a1/download", {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(
      redirect.headers.get("location"),
      `/api/agent-sources/docker%3A${sourceId}/artifacts/a1/file`,
    );
    // The Docker server's own policy replaces the Host page policy.
    const app = await fetch(base + "artifacts/a1/app", { headers: { cookie } });
    assert.equal(
      app.headers.get("content-security-policy"),
      "sandbox allow-scripts; frame-ancestors 'self'",
    );
    // Links made with the container id before stable ids still resolve.
    assert.equal(
      (
        await fetch(
          host.origin + `/api/agent-sources/docker%3A${containerId}/artifacts/a1/app`,
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
  } finally {
    process.env.PATH = priorPath;
    if (host) await host.close();
    await new Promise<void>((resolve) => old.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
