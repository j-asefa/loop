import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const dir = mkdtempSync(join(tmpdir(), "loop-catalog-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP_RUNTIME_URL = "http://127.0.0.1:31999";
process.env.LOOP_RUNTIME_TOKEN =
  "fixture-runtime-token-with-at-least-32-characters";
const authorization = vi.hoisted(() => vi.fn());
vi.mock("../src/server/mcp/client.js", async (original) => ({
  ...(await original<object>()),
  authorize: authorization,
}));
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent, owned, Problem } = await import("../src/server/domain");
const { mcp } = await import("../src/server/mcp/routes");
const { catalog } = await import("../src/server/mcp/catalog-data");
const { catalogSecret } = await import("../src/server/mcp/catalog");
const { readSecret, withTestMcp, oauthProvider } =
  await import("../src/server/mcp/client");
const { toolBindings, authorizeTool } =
  await import("../src/server/mcp/broker");
const { parseMcpConfig } = await import("../src/server/mcp/install");
const discovery = new Map<string, number>();
let fail = false,
  calls = 0;
const resetMcp = withTestMcp(async (c) => {
  discovery.set(c.id, (discovery.get(c.id) || 0) + 1);
  await new Promise((r) => setTimeout(r, 10));
  if (fail) throw new Error("Upstream error containing secret-never-echo-this");
  const server = new McpServer({ name: "catalog fixture", version: "1" });
  server.registerTool("inspect", { description: "Fixture tool" }, async () => {
    calls++;
    return { content: [{ type: "text", text: "fixture" }] };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "fixture", version: "1" });
  await client.connect(b);
  return client;
});
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-test-owner") || "alice";
  next();
});
app.use(mcp);
app.use((error: Error, _req: any, res: any, _next: any) =>
  res
    .status(error instanceof Problem ? error.status : 400)
    .json({ error: error.message }),
);
let server: ReturnType<typeof app.listen>, origin: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r, reject) => {
    server.once("listening", r);
    server.once("error", reject);
  });
  origin = "http://127.0.0.1:" + (server.address() as any).port;
});
afterAll(async () => {
  resetMcp();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function api(
  path: string,
  body?: unknown,
  owner = "alice",
  method?: string,
) {
  const r = await fetch(origin + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-test-owner": owner },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
const install = (name: string, body = {}, owner = "alice") =>
  api(`/mcp/catalog/${name}/install`, body, owner);
const row = (connection: string) =>
  owned<any>("mcp_connections", connection, "alice");
it("publishes 50 unique sourced entries whose pinned configurations pass the normal MCP parser", async () => {
  const response = await api("/mcp/catalog");
  expect(response.status).toBe(200);
  expect(response.data.entries).toHaveLength(50);
  expect(new Set(catalog.map((c) => c.id)).size).toBe(50);
  for (const entry of catalog) {
    expect(entry.source).toMatch(/^https:\/\//);
    const values = Object.fromEntries(
      entry.inputs.map((i) => [i.key, "fixture-value"]),
    );
    const secret = catalogSecret(entry, values);
    if (secret.stdio) {
      expect(secret.stdio.args[1]).toMatch(/@\d+\.\d+\.\d+$/);
      expect(
        parseMcpConfig({ mcpServers: { [entry.name]: secret.stdio } }),
      ).toHaveLength(1);
    } else
      expect(
        parseMcpConfig({
          mcpServers: { [entry.name]: { url: entry.serverUrl } },
        }),
      ).toHaveLength(1);
  }
  expect(response.data.entries.every((c: any) => !c.server)).toBe(true);
});
it("one click discovers tools, concurrent/repeated installs reuse one workspace connection, and installation never calls a tool", async () => {
  const results = await Promise.all([install("deepwiki"), install("deepwiki")]);
  const connection = results[0].data.id;
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  expect(results[0].data).toMatchObject({ status: "connected", tools: 1 });
  expect(results[1].data.id).toBe(connection);
  expect(discovery.get(connection)).toBe(1);
  expect((await install("deepwiki")).data.id).toBe(connection);
  expect(discovery.get(connection)).toBe(1);
  expect(calls).toBe(0);
  expect((await install("deepwiki", {}, "bob")).data.id).not.toBe(connection);
});
it("rejects missing credentials, unknown setup fields, custom commands and foreign runtime hosts before installation", async () => {
  const before = db.prepare("SELECT count(*) AS n FROM mcp_connections").get();
  for (const [name, payload, status] of [
    ["github", {}, 400],
    ["github", { values: { token: "key", url: "https://evil.example" } }, 400],
    ["missing", {}, 404],
    ["playwright", { command: "sh" }, 400],
    ["playwright", { runtimeHostId: "another-owner-host" }, 404],
    ["deepwiki", { runtimeHostId: "host" }, 400],
  ] as const)
    expect((await install(name, payload)).status).toBe(status);
  expect(db.prepare("SELECT count(*) AS n FROM mcp_connections").get()).toEqual(
    before,
  );
});
it("keeps supplied keys only in encrypted secrets and makes installed tools available to all agents with approvals intact", async () => {
  const response = await install("github", {
    values: { token: "secret-never-echo-this" },
  });
  expect(response.data.status).toBe("connected");
  const c = row(response.data.id);
  expect(readSecret(c).token).toBe("secret-never-echo-this");
  expect(JSON.stringify(c)).not.toContain("secret-never-echo-this");
  expect(JSON.stringify((await api("/mcp")).data)).not.toContain(
    "secret-never-echo-this",
  );
  const provider = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Fixture',?,'connected',?,?)",
  ).run(
    provider,
    seal("fixture", "alice"),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  for (const name of ["one", "two"]) {
    const agent = createAgent("alice", {
      name,
      connectionId: provider,
      model: "fixture",
    });
    expect(
      toolBindings("alice", agent.id).some((b) => b.connectionId === c.id),
    ).toBe(true);
    expect(
      authorizeTool("alice", agent.id, c.id, "inspect", {}).connection.id,
    ).toBe(c.id);
  }
});
it("persists failures truthfully, retries without duplicates, and reuses saved credentials when re-enabling", async () => {
  fail = true;
  const failed = await install("jina", {
    values: { token: "secret-never-echo-this" },
  });
  fail = false;
  expect(failed.data.status).toBe("needs_auth");
  expect(failed.data.error).not.toContain("secret-never-echo-this");
  expect(row(failed.data.id).status).toBe("needs_auth");
  expect((await install("jina")).data).toMatchObject({
    id: failed.data.id,
    status: "connected",
  });
  await api("/mcp/" + failed.data.id, { action: "disable" }, "alice", "PATCH");
  expect((await install("jina")).data.status).toBe("connected");
  expect(readSecret(row(failed.data.id)).token).toBe("secret-never-echo-this");
  await api(
    "/mcp/" + failed.data.id,
    { action: "disconnect" },
    "alice",
    "PATCH",
  );
  expect((await install("jina")).status).toBe(400);
  expect(
    (await install("jina", { values: { token: "replacement" } })).data.id,
  ).toBe(failed.data.id);
  expect(readSecret(row(failed.data.id)).token).toBe("replacement");
});
it("starts OAuth without falsely reporting installed and supports registered client credentials", async () => {
  authorization.mockResolvedValue({
    result: "REDIRECT",
    authorizationUrl: "https://auth.example/consent",
  });
  const notion = await install("notion");
  expect(notion.data).toMatchObject({
    status: "needs_auth",
    authorizationUrl: "https://auth.example/consent",
  });
  expect(row(notion.data.id).status).toBe("needs_auth");
  expect(discovery.has(notion.data.id)).toBe(false);
  const slack = await install("slack", {
    values: { clientId: "test-app", clientSecret: "test-secret" },
  });
  const { provider } = oauthProvider(row(slack.data.id));
  expect(provider.clientMetadata.token_endpoint_auth_method).toBe(
    "client_secret_post",
  );
  expect(await provider.clientInformation()).toMatchObject({
    client_id: "test-app",
    client_secret: "test-secret",
  });
  await provider.invalidateCredentials?.("all");
  expect(await provider.clientInformation()).toMatchObject({
    client_id: "test-app",
  });
  expect(JSON.stringify((await api("/mcp")).data)).not.toContain("test-secret");
});
it("reuses manual hosted installations and installs stdio packages on the selected owned runtime", async () => {
  const manual = await api("/mcp", {
    name: "Existing docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    auth: { type: "none" },
  });
  const result = await install("cloudflare-docs");
  expect(result.data.id).toBe(manual.data.id);
  expect(JSON.parse(row(result.data.id).metadata).catalogId).toBe(
    "cloudflare-docs",
  );
  const host = id();
  db.prepare(
    "INSERT INTO runtime_hosts(id,owner_id,name,url,secret,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    host,
    "alice",
    "Owned remote",
    "https://runtime.example",
    seal("fixture-token", "alice"),
    now(),
  );
  const remote = await install("brave-search", {
    runtimeHostId: host,
    values: { BRAVE_API_KEY: "fixture-brave" },
  });
  expect(remote.data.status).toBe("connected");
  expect(JSON.parse(row(remote.data.id).metadata).runtimeHostId).toBe(host);
  expect(readSecret(row(remote.data.id)).stdio).toEqual({
    command: "npx",
    args: [
      "--yes",
      "@brave/brave-search-mcp-server@2.1.4",
      "--transport",
      "stdio",
    ],
    env: { BRAVE_API_KEY: "fixture-brave" },
  });
});
it("keeps query-based API keys out of public URLs and supports rotating a catalog credential", async () => {
  const { connectionUrl } = await import("../src/server/mcp/client");
  const result = await install("browserbase", {
    values: { token: "private-query-key" },
  });
  expect(result.data.status).toBe("connected");
  const c = row(result.data.id);
  expect(c.url).toBe("https://mcp.browserbase.com/mcp");
  expect(connectionUrl(c).searchParams.get("browserbaseApiKey")).toBe(
    "private-query-key",
  );
  expect(JSON.stringify((await api("/mcp")).data)).not.toContain(
    "private-query-key",
  );
  const updated = await install("browserbase", {
    values: { token: "rotated-query-key" },
  });
  expect(updated.data.id).toBe(c.id);
  expect(connectionUrl(row(c.id)).searchParams.get("browserbaseApiKey")).toBe(
    "rotated-query-key",
  );
});
