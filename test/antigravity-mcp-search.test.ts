import { testDirectory } from "./helpers/test-workspace.js";
import { gitProject } from "./helpers/git-project.js";
import { seedConnection, seedConversation } from "./helpers/seed.js";
import { until } from "./helpers/wait.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";

const root = testDirectory();
gitProject(root);
const { db, id, now } = await import("../src/server/db");
const { OWNER } = await import("../src/server/workspace-identity");
const { createAgent } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { decide } = await import("../src/server/approvals");
const { createPresetTeam } = await import("../src/server/teams");
const { withTestMcp } = await import("../src/server/mcp/client");
const nativeDispatchQueries = await import("../src/server/sql/native-dispatch");
const { nativeSessions } = await import("../src/server/native-sessions");
const { NativeToolBridge } = await import("../src/server/native-tool-bridge");
const {
  MCP_CALL_TOOL,
  MCP_SEARCH_TOOL,
  deferredMcpMetaBindings,
  externalToolName,
  searchExternalBindings,
} = await import("../src/server/native-mcp-search");

let remoteCalls = 0;
const resetMcp = withTestMcp(async () => {
  const server = new McpServer({ name: "fixture-github", version: "1.0.0" });
  server.registerTool(
    "create_issue",
    {
      description: "Create a GitHub issue",
      inputSchema: { title: z.string() },
    },
    async ({ title }) => {
      remoteCalls += 1;
      return {
        content: [{ type: "text", text: `Created issue: ${title}` }],
      };
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "loop-fixture-client", version: "1.0.0" });
  await client.connect(b);
  return client;
});

const bridge = new NativeToolBridge();
await bridge.start();
nativeSessions.tools = (conversation, generation) =>
  bridge.issue(conversation, generation);
nativeSessions.revokeTools = (conversation, generation) =>
  bridge.revoke(conversation, generation);

afterAll(async () => {
  resetMcp();
  await nativeSessions.close();
  await bridge.close();
  delete process.env.LOOP_TEST_AGY_SESSION_ID;
  delete process.env.LOOP_TEST_AGY_VERSION;
  db.close();
});

function seedExternalServer(
  owner: string,
  name: string,
  tools: Array<{ name: string; description: string; inputSchema: any }>,
) {
  const cid = id();
  db.prepare(
    "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,tools,metadata,created_at) VALUES(?,?,?,?,?,'connected',?,?,?)",
  ).run(
    cid,
    owner,
    name,
    "https://fixture.example/mcp",
    seal(JSON.stringify({ type: "none" }), owner),
    JSON.stringify(tools),
    JSON.stringify({ transport: "http" }),
    now(),
  );
  return cid;
}

async function openMcpClient(ticket: { url: string; token: string }) {
  const client = new Client({ name: "antigravity-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(ticket.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${ticket.token}` },
    },
  });
  await client.connect(transport);
  return client;
}

it("keeps deferred meta-tools compact even with dozens of connected servers and ranks camelCase/snake_case queries", () => {
  const many = Array.from({ length: 30 }, (_, s) => ({
    name: externalToolName(`conn-${s}`, `listIssues_${s}`),
    connectionId: `conn-${s}`,
    server: `IntegrationServerNumber${s}`,
    tool: s === 5 ? "listPullRequests" : `tool_${s}`,
    description:
      s === 5
        ? "IntegrationServerNumber5 listPullRequests: List open pull requests"
        : `IntegrationServerNumber${s} tool_${s}: Example tool`,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: { repo: { type: "string", minLength: 1, maxLength: 200 } },
    },
  }));

  const meta = deferredMcpMetaBindings(many);
  expect(meta.map((b) => b.name)).toEqual([MCP_SEARCH_TOOL, MCP_CALL_TOOL]);
  for (const binding of meta) {
    const bytes = Buffer.byteLength(
      JSON.stringify({
        name: binding.name,
        description: binding.description,
        parameters: binding.inputSchema,
      }),
      "utf8",
    );
    expect(bytes, `${binding.name} serialized to ${bytes} bytes`).toBeLessThan(
      900,
    );
  }
  expect(meta[0].description).toContain("more");

  const found = searchExternalBindings(many, { query: "pull requests" });
  expect(found.total).toBe(1);
  expect(found.tools[0]).toMatchObject({
    server: "IntegrationServerNumber5",
    tool: "listPullRequests",
  });
  expect(JSON.stringify(found.tools[0].inputSchema)).not.toContain('"$schema"');

  const paged = searchExternalBindings(many, { limit: 5, offset: 0 });
  expect(paged.total).toBe(30);
  expect(paged.tools).toHaveLength(5);
  expect(paged.nextOffset).toBe(5);
});

it("keeps Antigravity tools/list under its eager budget with 200+ MCP tools and routes loop_mcp_call through approvals, owner checks, and live discovery", async () => {
  const fixture = resolve("test/fixtures/fake-antigravity.mjs");
  process.env.LOOP_TEST_AGY_VERSION = "1.5.12";
  await nativeSessions.projects.enable({
    harness: "antigravity",
    executable: fixture,
    version: "1.5.12",
    project: root,
    billing: "existing",
  });

  // Seed 210 external MCP tools across GitHub, Linear, and Playwright
  // plus another owner's private MCP connection to verify owner isolation.
  const githubId = seedExternalServer(OWNER, "GitHub", [
    {
      name: "create_issue",
      description: "Create a GitHub issue in a repository",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
    ...Array.from({ length: 49 }, (_, i) => ({
      name: `github_tool_${i}`,
      description: `GitHub operation ${i} `.repeat(15),
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          payload: { type: "string", description: "Details".repeat(20) },
        },
      },
    })),
  ]);
  seedExternalServer(
    OWNER,
    "Linear",
    Array.from({ length: 80 }, (_, i) => ({
      name: `linearAction${i}`,
      description: `Linear workflow tool ${i} `.repeat(15),
      inputSchema: {
        type: "object",
        properties: { teamId: { type: "string" }, query: { type: "string" } },
      },
    })),
  );
  seedExternalServer(
    OWNER,
    "Playwright",
    Array.from({ length: 80 }, (_, i) => ({
      name: `browser_action_${i}`,
      description: `Playwright browser helper ${i} `.repeat(15),
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string" } },
      },
    })),
  );
  const otherOwnerConnId = seedExternalServer("other-owner", "SecretServer", [
    {
      name: "secret_op",
      description: "Other owner tool",
      inputSchema: { type: "object" },
    },
  ]);

  // Seed a review team so loop_request_review is advertised too.
  seedConnection(db, {
    id: "agy-review-conn",
    owner_id: OWNER,
    provider: "openai",
    label: "Review fixture",
    secret: "",
    status: "connected",
    models: JSON.stringify([{ id: "m1", name: "M1" }]),
    metadata: "{}",
    created_at: 0,
  });
  const folder = nativeSessions.projects.addProject(root, "AgySearch").id;
  createPresetTeam(OWNER, {
    presetId: "code-review",
    name: "Loop review team lean",
    folderId: folder,
    selection: { connectionId: "agy-review-conn", model: "m1" },
    idempotencyKey: "agy-search-review-team",
  });

  const agent = createAgent(OWNER, {
    name: "agy-mcp-worker",
    connectionId: "native-antigravity",
    model: "native-default",
  });
  const convId = "agy-mcp-conv";
  seedConversation(db, {
    id: convId,
    owner_id: OWNER,
    agent_id: agent.id,
    title: "Agy MCP Search",
    created_at: 0,
  });
  const run = enqueue(OWNER, "Use GitHub", convId, {
    conversation: convId,
    agent: agent.id,
    payload: {
      agentId: agent.id,
      name: agent.name,
      provider: "antigravity",
      folderId: folder,
      connectionId: "native-antigravity",
      model: "native-default",
      instructions: "",
    },
  });
  const active = claim("agy-mcp-test", (r) => r.id === run.id)!;
  process.env.LOOP_TEST_AGY_SESSION_ID = convId;
  const live = await nativeSessions.session(active);
  const ticket = bridge.issue(convId, live.generation);
  nativeDispatchQueries.insertUnknown(
    db,
    active.id,
    live.generation,
    "digest",
    now(),
  );
  nativeDispatchQueries.acceptUnknown(db, active.id);
  nativeSessions.state.startTurn(live, active);
  const client = await openMcpClient(ticket);

  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "loop_request_review",
        "loop_agents",
        "loop_message",
        "loop_handoff",
        MCP_SEARCH_TOOL,
        MCP_CALL_TOOL,
      ]),
    );
    expect(names.filter((n) => /^loop_mcp_[0-9a-f]{20}$/.test(n))).toEqual([]);
    const totalBytes = Buffer.byteLength(JSON.stringify(listed.tools), "utf8");
    expect(totalBytes).toBeLessThan(16_384);

    // Direct invocation of an unadvertised loop_mcp_<hash> must be refused.
    const createIssueId = externalToolName(githubId, "create_issue");
    await expect(
      client.callTool({
        name: createIssueId,
        arguments: { title: "bypass" },
      }),
    ).rejects.toThrow(/Tool was not advertised/);

    // loop_mcp_search discovers GitHub tools and never leaks other-owner connections.
    const searchRes = await client.callTool({
      name: MCP_SEARCH_TOOL,
      arguments: { server: "GitHub", query: "create issue" },
    });
    expect(searchRes.isError).toBeFalsy();
    const parsedSearch = JSON.parse(
      (searchRes.content as Array<{ text: string }>)[0].text,
    );
    expect(parsedSearch.servers).toEqual(
      expect.arrayContaining([
        { name: "GitHub", tools: 50 },
        { name: "Linear", tools: 80 },
        { name: "Playwright", tools: 80 },
      ]),
    );
    expect(
      parsedSearch.servers.some(
        (s: { name: string }) => s.name === "SecretServer",
      ),
    ).toBe(false);
    expect(parsedSearch.tools[0]).toMatchObject({
      toolId: createIssueId,
      server: "GitHub",
      tool: "create_issue",
    });

    // loop_mcp_call rejects internal __loop__ tool names and other owners' toolIds.
    const internalBlocked = await client.callTool({
      name: MCP_CALL_TOOL,
      arguments: { toolId: "loop_request_review", arguments: {} },
    });
    expect(internalBlocked.isError).toBe(true);
    const crossOwnerBlocked = await client.callTool({
      name: MCP_CALL_TOOL,
      arguments: {
        toolId: externalToolName(otherOwnerConnId, "secret_op"),
        arguments: {},
      },
    });
    expect(crossOwnerBlocked.isError).toBe(true);

    // loop_mcp_call routes through real invokeTool + approval wait + execution.
    const pendingCall = client.callTool({
      name: MCP_CALL_TOOL,
      arguments: {
        toolId: createIssueId,
        arguments: { title: "Re-enable GitHub" },
      },
    });
    await until(
      () =>
        db
          .prepare("SELECT state FROM runs WHERE id=?")
          .pluck()
          .get(active.id) === "awaiting_approval",
    );
    const approval = db
      .prepare(
        "SELECT id, request FROM approvals WHERE run_id=? AND state='pending'",
      )
      .get(active.id) as { id: string; request: string };
    expect(approval).toBeTruthy();
    expect(JSON.parse(approval.request)).toMatchObject({
      tool: "create_issue",
      server: "GitHub",
      arguments: { title: "Re-enable GitHub" },
    });
    decide(OWNER, approval.id, "approve");
    const callResult = await pendingCall;
    expect(callResult.content).toEqual([
      { type: "text", text: "Created issue: Re-enable GitHub" },
    ]);
    expect(callResult.isError).toBeFalsy();
    expect(remoteCalls).toBe(1);

    // Mid-session newly enabled MCP server is discovered immediately without restart.
    const lateId = seedExternalServer(OWNER, "LateServer", [
      {
        name: "create_issue",
        description: "Late server issue creator",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    ]);
    const lateSearch = await client.callTool({
      name: MCP_SEARCH_TOOL,
      arguments: { server: "LateServer" },
    });
    const lateParsed = JSON.parse(
      (lateSearch.content as Array<{ text: string }>)[0].text,
    );
    expect(lateParsed.tools[0].toolId).toBe(
      externalToolName(lateId, "create_issue"),
    );

    // Disabling GitHub blocks subsequent loop_mcp_call attempts, and reusing a
    // request identity with different arguments fails with HTTP 409.
    const callPi = (reqId: string, toolArgs: Record<string, unknown>) =>
      fetch(ticket.url + "/pi", {
        method: "POST",
        headers: { Authorization: `Bearer ${ticket.token}` },
        body: JSON.stringify({
          method: "tools/call",
          id: reqId,
          name: MCP_CALL_TOOL,
          arguments: toolArgs,
        }),
      });
    db.prepare("UPDATE mcp_connections SET status='disabled' WHERE id=?").run(
      githubId,
    );
    const disabledRes = await callPi("after-disable", {
      toolId: createIssueId,
      arguments: { title: "Should fail" },
    });
    expect(await disabledRes.json()).toMatchObject({
      isError: true,
      content: [
        { text: expect.stringContaining("disabled or needs reconnecting") },
      ],
    });
    const reusedMismatch = await callPi("after-disable", {
      toolId: createIssueId,
      arguments: { title: "Tampered" },
    });
    expect(reusedMismatch.status).toBe(409);
  } finally {
    await client.close();
    nativeSessions.state.endTurn(live);
    transition(active, "completed");
    await nativeSessions.dispose(live);
    delete process.env.LOOP_TEST_AGY_VERSION;
  }
});

it("never advertises loop_mcp_search or loop_mcp_call to Antigravity snapshot review runs", async () => {
  process.env.LOOP_TEST_AGY_VERSION = "1.5.12";
  const agent = createAgent(OWNER, {
    name: "agy-reviewer",
    connectionId: "native-antigravity",
    model: "native-default",
  });
  const convId = "agy-review-only-conv";
  seedConversation(db, {
    id: convId,
    owner_id: OWNER,
    agent_id: agent.id,
    title: "Agy Review",
    created_at: 0,
  });
  const run = enqueue(OWNER, "Review snapshot", convId, {
    conversation: convId,
    agent: agent.id,
    payload: {
      agentId: agent.id,
      name: agent.name,
      provider: "antigravity",
      folderId: null,
      connectionId: "native-antigravity",
      model: "native-default",
      instructions: "",
      reviewId: "review-snapshot-1",
    },
  });
  const active = claim("agy-review-test", (r) => r.id === run.id)!;
  process.env.LOOP_TEST_AGY_SESSION_ID = convId;
  const live = await nativeSessions.session(active);
  const ticket = bridge.issue(convId, live.generation);
  const client = await openMcpClient(ticket);
  try {
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["loop_review_read"]);
  } finally {
    await client.close();
    transition(active, "completed");
    await nativeSessions.dispose(live);
    delete process.env.LOOP_TEST_AGY_VERSION;
  }
});
