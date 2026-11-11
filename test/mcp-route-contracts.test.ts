import { afterAll, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";

const native = vi.hoisted(() => ({ home: "", authorize: vi.fn() }));
vi.mock("node:os", async (original) => ({
  ...(await original<object>()),
  homedir: () => native.home,
}));
vi.mock("../src/server/mcp/client.js", async (original) => ({
  ...(await original<object>()),
  authorize: native.authorize,
}));
const directory = mkdtempSync(join(tmpdir(), "loop-mcp-contracts-"));
native.home = join(directory, "native");
mkdirSync(native.home);
const bin = join(directory, "bin");
mkdirSync(bin);
// Only the native I/O boundary is substituted; list/import use their production parsers.
writeFileSync(join(bin, "codex"), "#!/bin/sh\nprintf '[]'\n", { mode: 0o755 });
vi.stubEnv("PATH", bin + ":" + process.env.PATH);
expect(existsSync(join(process.cwd(), ".mcp.json"))).toBe(false);
writeFileSync(
  join(native.home, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      "contract-native": {
        url: "https://native.example/mcp",
        headers: { Authorization: "Bearer native-private-value" },
      },
    },
  }),
);
process.env.LOOP_DATA_DIR = join(directory, "data");
process.env.LOOP_URL = "http://127.0.0.1";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { config, setWorkspaceUrl } = await import("../src/server/config");
const { withTestMcp, oauthProvider, readSecret } =
  await import("../src/server/mcp/client");
const { withTestAdapter } = await import("../src/server/providers");
const { ownedMcpConnection, ownedRun } = await import("../src/server/domain");
const { saveArtifact } = await import("../src/server/artifacts");
const { claim, transition } = await import("../src/server/queue");
const { executeMcp } = await import("../src/server/mcp/routes");
const { decide } = await import("../src/server/approvals");
const { ToolBudgetError } = await import("../src/server/mcp/tool-budget");
const { closeExecution } = await import("../src/server/execution-client");
const { nativeSessions } = await import("../src/server/native-sessions");
const { OWNER: owner } = await import("../src/server/workspace-identity");
const { app } = await import("../src/server/index");
let externalCalls = 0;
let discoveryFailure: Error | undefined;
const resetMcp = withTestMcp(async () => {
  if (discoveryFailure) throw discoveryFailure;
  const mcp = new McpServer({ name: "Contract fixture", version: "1" });
  mcp.registerTool(
    "inspect",
    { inputSchema: { query: z.string() } },
    async ({ query }) => {
      externalCalls++;
      return { content: [{ type: "text", text: query }] };
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: "Contract fixture client", version: "1" });
  await client.connect(b);
  return client;
});
const resetProvider = withTestAdapter("openai", {
  async models() {
    return [{ id: "fixture", name: "Fixture", capabilities: "Fixture only" }];
  },
  async *stream() {
    yield { text: "Fixture" };
  },
});
native.authorize.mockImplementation(async (connection, code) => {
  const { provider } = oauthProvider(connection);
  if (code) {
    await provider.saveTokens({
      access_token: "oauth-private-access",
      refresh_token: "oauth-private-refresh",
      token_type: "Bearer",
    });
    return { result: "AUTHORIZED" };
  }
  return {
    result: "REDIRECT",
    authorizationUrl:
      "https://oauth.example/authorize?state=" + (await provider.state!()),
  };
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
config.port = (server.address() as AddressInfo).port;
const origin = "http://127.0.0.1:" + config.port;
setWorkspaceUrl(origin);

afterAll(async () => {
  resetMcp();
  resetProvider();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeExecution();
  await nativeSessions.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  raw?: string,
  base = origin,
  headers: Record<string, string> = {},
) {
  const payload =
    raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise<{
    status: number;
    data: any;
    headers: import("node:http").IncomingHttpHeaders;
  }>((resolve, reject) => {
    const req = httpRequest(
      base + "/api" + path,
      {
        method,
        headers: {
          "content-type": "application/json",
          origin: base,
          ...(payload === undefined
            ? {}
            : { "content-length": Buffer.byteLength(payload) }),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode!,
            data:
              res.headers["content-type"]?.includes("application/json") && text
                ? JSON.parse(text)
                : text,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
function valid(
  contract: RouteContract,
  response: Awaited<ReturnType<typeof request>>,
  status = contract.status ?? 200,
) {
  expect(response.status, contract.path).toBe(status);
  if (contract.kind !== "stream")
    expect(contract.response.parse(response.data)).toEqual(response.data);
  return response.data;
}
async function invalid(
  path: string,
  body: unknown,
  method: string,
  raw?: string,
) {
  expect(await request(path, body, method, raw)).toMatchObject({
    status: 400,
    data: { error: expect.any(String) },
  });
}
async function connection(auth: unknown = { type: "none" }) {
  return valid(
    workspaceApi.mcpCreate,
    await request("/mcp", {
      name: "Contract " + id(),
      url: "https://fixture.example/mcp",
      auth,
    }),
  );
}

it("projects real connection rows, drops sealed credentials and preserves the credential lifecycle", async () => {
  const c = await connection({ type: "bearer", token: "manual-private-value" });
  expect(c).toMatchObject({
    owner_id: owner,
    tools: "[]",
    metadata: "{}",
    authType: "bearer",
    created_at: expect.any(Number),
  });
  await invalid(
    "/mcp",
    { name: "", url: "https://fixture.example", auth: { type: "none" } },
    "POST",
  );
  const oauth = await connection({ type: "oauth" });
  const { provider } = oauthProvider(ownedMcpConnection(oauth.id, owner));
  await provider.saveTokens({
    access_token: "saved-private-access",
    refresh_token: "saved-private-refresh",
    token_type: "Bearer",
  });
  await provider.saveClientInformation!({
    client_id: "fixture",
    client_secret: "saved-private-client-secret",
  });
  const stored = ownedMcpConnection(oauth.id, owner);
  expect(readSecret(stored).tokens.access_token).toBe("saved-private-access");
  db.exec(
    "ALTER TABLE mcp_connections ADD COLUMN accidental_private TEXT DEFAULT 'private-added-column'",
  );
  const list = valid(workspaceApi.mcpList, await request("/mcp"));
  expect(list.find((row: any) => row.id === oauth.id).authType).toBe("oauth");
  const wire = JSON.stringify(list);
  for (const secret of [
    stored.secret,
    "private-added-column",
    "manual-private-value",
    "saved-private-access",
    "saved-private-refresh",
    "saved-private-client-secret",
    '"secret"',
    '"tokens"',
  ])
    expect(wire).not.toContain(secret);
  await invalid("/mcp", {}, "GET");
  db.prepare(
    "UPDATE mcp_connections SET created_at='private-invalid-output' WHERE id=?",
  ).run(c.id);
  try {
    expect(await request("/mcp")).toMatchObject({
      status: 500,
      data: {
        error: "The workspace response is unavailable. Please try again.",
      },
    });
  } finally {
    db.prepare("UPDATE mcp_connections SET created_at=? WHERE id=?").run(
      c.created_at,
      c.id,
    );
  }

  valid(workspaceApi.mcpTest, await request(`/mcp/${c.id}/test`, {}));
  await invalid(`/mcp/${c.id}/test`, undefined, "POST", "{");
  for (const action of ["disable", "enable"])
    valid(
      workspaceApi.mcpUpdate,
      await request(`/mcp/${c.id}`, { action }, "PATCH"),
    );
  valid(
    workspaceApi.mcpUpdate,
    await request(
      `/mcp/${c.id}`,
      {
        action: "credentials",
        auth: {
          type: "headers",
          headers: { Authorization: "rotated-private-value" },
        },
      },
      "PATCH",
    ),
  );
  await invalid(`/mcp/${c.id}`, { action: "credentials" }, "PATCH");
  await invalid(`/mcp/${c.id}`, { action: "invented" }, "PATCH");
  db.prepare(
    "UPDATE mcp_connections SET secret='damaged',owner_id=? WHERE id=?",
  ).run("other-owner", c.id);
  expect(
    (await request(`/mcp/${c.id}`, { action: "disconnect" }, "PATCH")).status,
  ).toBe(404);
  expect(
    db.prepare("SELECT secret FROM mcp_connections WHERE id=?").get(c.id),
  ).toEqual({ secret: "damaged" });
  db.prepare("UPDATE mcp_connections SET owner_id=? WHERE id=?").run(
    owner,
    c.id,
  );
  expect(() => ownedMcpConnection(c.id, owner)).toThrow("invalid secret");
  const disconnected = valid(
    workspaceApi.mcpUpdate,
    await request(`/mcp/${c.id}`, { action: "disconnect" }, "PATCH"),
  );
  expect(disconnected).toMatchObject({
    status: "disconnected",
    authType: "none",
  });
  expect(readSecret(ownedMcpConnection(c.id, owner))).toEqual({ type: "none" });
});

it("keeps preference strictness, catalog branch shapes and pasted setup values private", async () => {
  valid(workspaceApi.mcpPreferences, await request("/mcp/preferences"));
  await invalid("/mcp/preferences", {}, "GET");
  valid(
    workspaceApi.mcpPreferencesUpdate,
    await request(
      "/mcp/preferences",
      { approvalMode: "ask", agentPermissionMode: "default" },
      "PUT",
    ),
  );
  for (const body of [
    {},
    { approvalMode: "invented" },
    { approvalMode: "ask", extra: true },
  ])
    await invalid("/mcp/preferences", body, "PUT");
  const catalog = valid(workspaceApi.mcpCatalog, await request("/mcp/catalog"));
  expect(catalog.entries.length).toBeGreaterThan(100);
  expect(
    catalog.entries.some(
      (entry: any) =>
        entry.transport === "stdio" && entry.serverUrl === undefined,
    ),
  ).toBe(true);
  expect(catalog.entries.some((entry: any) => entry.note === undefined)).toBe(
    true,
  );
  await invalid("/mcp/catalog", {}, "GET");
  const installed = valid(
    workspaceApi.mcpCatalogInstall,
    await request("/mcp/catalog/github/install", {
      values: { token: "catalog-private-value" },
    }),
  );
  expect(installed.status).toBe("connected");
  expect(readSecret(ownedMcpConnection(installed.id, owner)).token).toBe(
    "catalog-private-value",
  );
  const redirect = valid(
    workspaceApi.mcpCatalogInstall,
    await request("/mcp/catalog/notion/install", {}),
  );
  expect(redirect).toMatchObject({
    status: "needs_auth",
    authorizationUrl: expect.any(String),
    tools: 0,
  });
  await invalid("/mcp/catalog/github/install", { values: null }, "POST");
  const config = {
    mcpServers: {
      "Pasted fixture": {
        url: "https://pasted.example/mcp",
        headers: { Authorization: "Bearer pasted-private-value" },
      },
    },
  };
  const pasted = valid(
    workspaceApi.mcpInstall,
    await request("/mcp/install", { config }),
  );
  expect(pasted[0]).toMatchObject({
    name: "Pasted fixture",
    status: "connected",
    tools: 1,
  });
  expect(
    readSecret(ownedMcpConnection(pasted[0].id, owner)).headers?.Authorization,
  ).toBe("Bearer pasted-private-value");
  valid(
    workspaceApi.mcpInstall,
    await request("/mcp/install", { config: JSON.stringify(config) }),
  );
  for (const body of [
    { config: null },
    { config: { mcpServers: {} } },
    { config: "{" },
    // Command tools run only on this computer; a remote destination is refused.
    { config, runtimeHostId: "remote-host" },
  ])
    await invalid("/mcp/install", body, "POST");
  for (const [failure, status] of [
    [new Error("private-provider-error"), "needs_auth"],
    [new ToolBudgetError(), "disabled"],
  ] as const) {
    discoveryFailure = failure;
    try {
      const result = valid(
        workspaceApi.mcpCatalogInstall,
        await request("/mcp/catalog/deepwiki/install", {}),
      );
      expect(result.status).toBe(status);
      const other = valid(
        workspaceApi.mcpInstall,
        await request("/mcp/install", {
          config: {
            mcpServers: { [id()]: { url: "https://failure.example/mcp" } },
          },
        }),
      );
      expect(other[0].status).toBe(status);
      expect(JSON.stringify([result, other])).not.toContain(
        "private-provider-error",
      );
    } finally {
      discoveryFailure = undefined;
    }
  }
  const wire = JSON.stringify((await request("/mcp")).data);
  for (const secret of [
    "pasted-private-value",
    "catalog-private-value",
    "mcpServers",
  ])
    expect(wire).not.toContain(secret);
});

it("imports native candidates through real parsing without exposing their configuration", async () => {
  const candidates = valid(
    workspaceApi.mcpNativeCandidates,
    await request("/mcp/native-candidates"),
  );
  expect(candidates).toEqual([
    {
      id: expect.any(String),
      name: "contract-native",
      provider: "Claude",
      kind: "http",
    },
  ]);
  expect(JSON.stringify(candidates)).not.toContain("native-private-value");
  await invalid("/mcp/native-candidates", {}, "GET");
  const path = `/mcp/native-candidates/${candidates[0].id}/import`;
  const installed = valid(
    workspaceApi.mcpNativeImport,
    await request(path, {}),
  );
  expect(installed[0]).toMatchObject({
    name: "Claude · contract-native",
    status: "connected",
  });
  expect(
    readSecret(ownedMcpConnection(installed[0].id, owner)).headers
      ?.Authorization,
  ).toBe("Bearer native-private-value");
  // Import intentionally ignores a JSON body; parser syntax remains the invalid-input boundary.
  await invalid(path, undefined, "POST", "{");
});

it("keeps OAuth state single-use and owner-bound while returning an HTML redirect", async () => {
  const c = await connection({ type: "oauth" });
  const started = valid(
    workspaceApi.mcpTest,
    await request(`/mcp/${c.id}/test`, {}),
  );
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  const callback = `/mcp/oauth/callback?state=${state}&code=fixture-code`;
  const response = await request(callback);
  valid(workspaceApi.mcpOauthCallback, response);
  expect(response.headers.location).toBe("/?tools=connected");
  expect(response.headers["content-type"]).toContain("text/plain");
  const htmlState = await oauthProvider(ownedMcpConnection(c.id, owner))
    .provider.state!();
  const html = await request(
    `/mcp/oauth/callback?state=${htmlState}&code=fixture`,
    undefined,
    "GET",
    undefined,
    origin,
    { accept: "text/html" },
  );
  valid(workspaceApi.mcpOauthCallback, html);
  expect(html.headers["content-type"]).toContain("text/html");
  expect(html.headers.location).toBe("/?tools=connected");

  expect(
    db.prepare("SELECT 1 FROM oauth_states WHERE state=?").get(state),
  ).toBeUndefined();
  expect((await request(callback)).status).toBe(403);
  const provider = oauthProvider(ownedMcpConnection(c.id, owner)).provider;
  const invalidState = await provider.state!();
  await invalid(`/mcp/oauth/callback?state=${invalidState}`, undefined, "GET");
  expect(
    db.prepare("SELECT 1 FROM oauth_states WHERE state=?").get(invalidState),
  ).toBeUndefined();
  const otherState = await provider.state!();
  db.prepare("UPDATE oauth_states SET owner_id=? WHERE state=?").run(
    "another-owner",
    otherState,
  );
  expect(
    (await request(`/mcp/oauth/callback?state=${otherState}&code=fixture`))
      .status,
  ).toBe(403);
  expect(
    db.prepare("SELECT 1 FROM oauth_states WHERE state=?").get(otherState),
  ).toBeDefined();
  const wire = JSON.stringify((await request("/mcp")).data);
  expect(wire).not.toContain("oauth-private-access");
  expect(wire).not.toContain("oauth-private-refresh");
});

it("keeps tool bindings, retired writes, iframe isolation and durable approval-gated artifact calls", async () => {
  const provider = (
    await request("/connections", {
      provider: "openai",
      label: "Contract provider",
      secret: "fixture-provider-secret",
    })
  ).data;
  const agentResponse = await request("/agents", {
    name: "contract-tool-agent",
    connectionId: provider.id,
    model: "fixture",
  });
  expect(agentResponse.status).toBe(201);
  const agent = agentResponse.data;
  const c = await connection();
  valid(workspaceApi.mcpTest, await request(`/mcp/${c.id}/test`, {}));
  const bindings = valid(
    workspaceApi.agentTools,
    await request(`/agents/${agent.id}/tools`),
  );
  expect(bindings).toContainEqual({ connection_id: c.id, tool: "inspect" });
  await invalid(`/agents/${agent.id}/tools`, {}, "GET");
  valid(
    workspaceApi.agentToolsUpdate,
    await request(`/agents/${agent.id}/tools`, { arbitrary: true }, "PUT"),
  );
  await invalid(`/agents/${agent.id}/tools`, undefined, "PUT", "{");
  expect((await request("/agents/foreign/tools", {}, "PUT")).status).toBe(404);
  const artifact = saveArtifact(owner, {
    title: "Stored MCP app",
    content: "Fixture",
    agent: agent.id,
    metadata: {
      connectionId: c.id,
      tool: "inspect",
      arguments: { query: "original" },
      appResource: { html: "<!doctype html><p>Isolated fixture app</p>" },
    },
  });
  const prefix = `/artifacts/${artifact}`;
  const iframe = await request(prefix + "/app");
  valid(workspaceApi.artifactApp, iframe);
  expect(iframe.data).toContain("Isolated fixture app");
  expect(iframe.headers["content-type"]).toContain("text/html");
  expect(iframe.headers["content-security-policy"]).toContain(
    "sandbox allow-scripts",
  );
  await invalid(prefix + "/app", {}, "GET");
  const input = {
    tool: "inspect",
    arguments: { query: "interactive" },
    idempotencyKey: id(),
  };
  const run = valid(
    workspaceApi.artifactToolCall,
    await request(prefix + "/tool-call", input),
  );
  expect(run.state).toBe("queued");
  expect(externalCalls).toBe(0);
  expect((await request(prefix + "/tool-call", input)).data.id).toBe(run.id);
  await invalid(
    prefix + "/tool-call",
    { ...input, idempotencyKey: "short" },
    "POST",
  );
  await invalid(prefix + "/tool-call", { ...input, arguments: null }, "POST");
  expect(
    await request(prefix + "/tool-call", {
      ...input,
      arguments: { query: 42 },
    }),
  ).toMatchObject({ status: 422, data: { error: expect.any(String) } });
  const refresh = valid(
    workspaceApi.artifactRefresh,
    await request(prefix + "/refresh", {
      idempotencyKey: id(),
      tool: "ignored",
      arguments: { query: "ignored" },
    }),
  );
  expect(JSON.parse(refresh.payload)).toMatchObject({
    tool: "inspect",
    arguments: { query: "original" },
    agentId: agent.id,
    connectionId: c.id,
  });
  await invalid(prefix + "/refresh", {}, "POST");
  const active = claim(
    "contract-worker",
    (candidate) => candidate.id === run.id,
  )!;
  expect(await executeMcp(active)).toBe(false);
  const toolActivity = () =>
    db
      .prepare(
        "SELECT owner_id,scope,run_id,record FROM agent_activities WHERE run_id=? AND kind='tool'",
      )
      .all(run.id) as {
      owner_id: string;
      scope: string;
      run_id: string;
      record: string;
    }[];
  expect(toolActivity()).toHaveLength(1);
  expect(toolActivity()[0]).toMatchObject({ owner_id: owner, run_id: run.id });
  expect(JSON.parse(toolActivity()[0].record).data).toMatchObject({
    title: "inspect",
    status: "waiting",
    links: { broker: "manual-call", trace: "tool:manual-call" },
  });

  expect(ownedRun(run.id, owner).state).toBe("awaiting_approval");
  expect(externalCalls).toBe(0);
  const approval = db
    .prepare("SELECT id FROM approvals WHERE run_id=?")
    .get(run.id) as { id: string };
  decide(owner, approval.id, "approve");
  const resumed = claim(
    "contract-worker",
    (candidate) => candidate.id === run.id,
  )!;
  expect(await executeMcp(resumed)).toBe(true);
  expect(externalCalls).toBe(1);
  expect(await executeMcp(resumed)).toBe(true);
  expect(externalCalls).toBe(1);
  expect(toolActivity()).toHaveLength(1);
  expect(JSON.parse(toolActivity()[0].record).data).toMatchObject({
    status: "completed",
    content: [{ type: "artifact", artifactId: expect.any(String) }],
  });
  expect(transition(resumed, "completed")).toBe(true);
  expect(transition(ownedRun(refresh.id, owner), "cancelled")).toBe(true);
  const foreign = saveArtifact("another-owner", {
    title: "Private",
    content: "Private",
    agent: agent.id,
  });
  expect((await request(`/artifacts/${foreign}/tool-call`, input)).status).toBe(
    404,
  );
  expect((await request(`/artifacts/${foreign}/app`)).status).toBe(404);
});
