import { it, expect, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
const dir = mkdtempSync(join(tmpdir(), "loop-mcp-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { withTestAdapter } = await import("../src/server/providers");
const { withTestMcp, discover, connect } =
  await import("../src/server/mcp/client");
const { safeUrl, publicAddress } = await import("../src/server/mcp/network");
const { queueTool } = await import("../src/server/mcp/routes");
const { authorizeTool, invokeTool, toolBindings } =
  await import("../src/server/mcp/broker");
const { decide } = await import("../src/server/approvals");
const approvalPolicy = await import("../src/server/mcp/approval-policy");
const { mcpApprovalMode, setMcpApprovalMode } = approvalPolicy;
const { submit } = await import("../src/server/agent-runtime");
const { tick, execute } = await import("../src/server/worker");
const { normalizeResult } = await import("../src/server/mcp/results");
let externalCalls = 0;
let resourceReads = 0;
const fixtureMcp = async () => {
  const server = new McpServer({
    name: "Loop deterministic fixture",
    version: "1",
  });
  server.registerTool(
    "metrics",
    {
      description: "Fixture metrics. No real Datadog data.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://fixture/chart" } },
    },
    async ({ query }) => {
      externalCalls++;
      if (query === "submission form")
        return {
          isError: true,
          structuredContent: { status: "awaiting_user_submission" },
          content: [
            { type: "text", text: "Review the form before submitting." },
          ],
        };
      return {
        content: [{ type: "text", text: "Fixture query result" }],
        structuredContent: {
          series: [
            {
              metric: "fixture.latency",
              unit: [{ short_name: "ms" }],
              pointlist: [
                [1700000000000, 12],
                [1700000060000, null],
                [1700000120000, 18],
              ],
            },
          ],
        },
      };
    },
  );
  server.registerResource(
    "chart",
    "ui://fixture/chart",
    { mimeType: "text/html;profile=mcp-app" },
    async (uri) => {
      resourceReads++;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/html;profile=mcp-app",
            text: "<!doctype html><p>Fixture app</p>",
          },
        ],
      };
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "loop-fixture-client", version: "1" });
  await client.connect(b);
  return client;
};
const resetMcp = withTestMcp(fixtureMcp);
const account = id();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Fixture',?,'connected',?,?)",
).run(
  account,
  seal("fixture", "alice"),
  JSON.stringify([{ id: "fixture" }]),
  now(),
);
const agent = createAgent("alice", {
  name: "mcp-fixture-agent",
  connectionId: account,
  model: "fixture",
});
const c = id();
db.prepare(
  "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,'alice','Fixture MCP','https://fixture.example/mcp',?,'connected',?,?)",
).run(
  c,
  seal(JSON.stringify({ type: "none" }), "alice"),
  JSON.stringify({ fixture: true }),
  now(),
);
const connection = () =>
  db.prepare("SELECT * FROM mcp_connections WHERE id=?").get(c) as any;
await discover(connection());

const resetProvider = withTestAdapter("openai", {
  async models() {
    return [];
  },
  async *stream(_secret, input) {
    if (!input.messages.some((m) => m.role === "tool"))
      yield {
        toolCall: {
          id: "call-1",
          name: input.tools![0].name,
          arguments: { query: "fixture latency" },
        },
      };
    else yield { text: "The measured fixture latency is saved in the chart." };
  },
});
afterAll(() => {
  resetMcp();
  resetProvider();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("shares installed MCPs with existing and future agents, but never across owners", () => {
  // An old installation granted tools to just one agent. Existing rows no longer
  // restrict the workspace catalog after an upgrade.
  db.prepare("INSERT INTO grants VALUES(?,?,?,?,?,'ask')").run(
    id(),
    "alice",
    agent.id,
    c,
    "metrics",
  );
  const later = createAgent("alice", {
    name: "new-workspace-agent",
    connectionId: account,
    model: "fixture",
  });
  const bobAccount = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'bob','openai','Fixture',?,'connected',?,?)",
  ).run(
    bobAccount,
    seal("fixture", "bob"),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  const bob = createAgent("bob", {
    name: "other-workspace-agent",
    connectionId: bobAccount,
    model: "fixture",
  });
  expect(toolBindings("alice", later.id)).toEqual(
    toolBindings("alice", agent.id),
  );
  expect(toolBindings("alice", later.id)).toMatchObject([
    { connectionId: c, tool: "metrics" },
  ]);
  expect(
    authorizeTool("alice", later.id, c, "metrics", { query: "inherited" })
      .connection.id,
  ).toBe(c);
  expect(toolBindings("bob", bob.id)).toEqual([]);
  expect(() => toolBindings("bob", later.id)).toThrow();
  expect(() =>
    authorizeTool("bob", bob.id, c, "metrics", { query: "private" }),
  ).toThrow();
  for (const state of ["disabled", "disconnected", "needs_auth"]) {
    db.prepare("UPDATE mcp_connections SET status=? WHERE id=?").run(state, c);
    expect(toolBindings("alice", agent.id)).toEqual([]);
    expect(toolBindings("alice", later.id)).toEqual([]);
    expect(() =>
      authorizeTool("alice", later.id, c, "metrics", { query: "blocked" }),
    ).toThrow();
  }
  db.prepare("UPDATE mcp_connections SET status='connected' WHERE id=?").run(c);
  db.prepare("DELETE FROM grants WHERE connection_id=?").run(c);
  expect(toolBindings("alice", agent.id)).toHaveLength(1);
});
it("includes every discovered workspace tool instead of silently dropping tools after forty", () => {
  const original = connection().tools;
  const catalog = Array.from({ length: 65 }, (_, i) => ({
    name: "tool_" + i,
    inputSchema: { type: "object" },
  }));
  try {
    db.prepare("UPDATE mcp_connections SET tools=? WHERE id=?").run(
      JSON.stringify(catalog),
      c,
    );
    expect(toolBindings("alice", agent.id).map((t) => t.tool)).toEqual(
      catalog.map((t) => t.name),
    );
  } finally {
    db.prepare("UPDATE mcp_connections SET tools=? WHERE id=?").run(
      original,
      c,
    );
  }
});
it("uses official MCP discovery, pauses model tool calls for approval and saves native data without fetching app resources", async () => {
  const run = submit("alice", {
    agentId: agent.id,
    input: "Show latency",
    idempotencyKey: "fixture-mcp-model",
  });
  await tick(execute);
  expect(externalCalls).toBe(0);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "awaiting_approval",
  });
  const approval = db
    .prepare("SELECT * FROM approvals WHERE run_id=?")
    .get(run.id) as any;
  const { parseRun } = await import("../src/server/row-schemas");
  const waiting = parseRun(
    db.prepare("SELECT * FROM runs WHERE id=?").get(run.id),
  );
  const binding = toolBindings("alice", agent.id).find(
    (item) => item.tool === "metrics",
  )!;
  const request = JSON.parse(approval.request);
  expect(
    await invokeTool(waiting, binding, request.callId, request.arguments),
  ).toMatchObject({ pending: approval.id });
  expect(() => decide("bob", approval.id, "approve")).toThrow();
  decide("alice", approval.id, "approve");
  await tick(execute);
  expect(externalCalls).toBe(1);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "completed",
  });
  const artifact = db
    .prepare("SELECT * FROM artifacts WHERE run_id=? AND kind='chart'")
    .get(run.id) as any;
  const data = JSON.parse(artifact.content);
  expect(data.series[0].points[1]).toEqual([1700000060000, null]);
  expect(data.series[0].unit).toBe("ms");
  expect(data.source.fixture).toBe(true);
  expect(JSON.parse(artifact.metadata).appResource).toBeUndefined();
  expect(resourceReads).toBe(0);
  expect(await tick(execute)).toBe(false);
  expect(externalCalls).toBe(1);
});
it("enforces ownership and schema on UI calls, and disabling a server after approval prevents external execution", async () => {
  expect(() => authorizeTool("bob", agent.id, c, "metrics", {})).toThrow();
  expect(() =>
    authorizeTool("alice", agent.id, c, "metrics", { query: 3 }),
  ).toThrow();
  expect(() =>
    queueTool("alice", {
      agentId: agent.id,
      connectionId: c,
      tool: "delete_everything",
      arguments: {},
      idempotencyKey: "bad-ui-tool-call",
    }),
  ).toThrow();
  const run = queueTool("alice", {
    agentId: agent.id,
    connectionId: c,
    tool: "metrics",
    arguments: { query: "revoked" },
    idempotencyKey: "disable-connection-test",
  });
  await tick(execute);
  const approval = db
    .prepare("SELECT * FROM approvals WHERE run_id=?")
    .get(run.id) as any;
  decide("alice", approval.id, "approve");
  db.prepare("UPDATE mcp_connections SET status='disabled' WHERE id=?").run(c);
  await tick(execute);
  expect(externalCalls).toBe(1);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "failed",
  });
  db.prepare("UPDATE mcp_connections SET status='connected' WHERE id=?").run(c);
});
it("never replays a call with uncertain outcome", async () => {
  const run = queueTool("alice", {
    agentId: agent.id,
    connectionId: c,
    tool: "metrics",
    arguments: { query: "fail" },
    idempotencyKey: "uncertain-outcome-test",
  });
  await tick(execute);
  const approval = db
    .prepare("SELECT * FROM approvals WHERE run_id=?")
    .get(run.id) as any;
  decide("alice", approval.id, "approve");
  // A server handler exception is an MCP isError response, not a lost reply.
  // Simulate the transport itself failing after the external request was sent.
  const restoreTransport = withTestMcp(
    async () =>
      ({
        async callTool() {
          externalCalls++;
          throw new Error("Fixture network uncertainty");
        },
        async close() {},
      }) as unknown as Client,
  );
  try {
    await tick(execute);
  } finally {
    restoreTransport();
    withTestMcp(fixtureMcp);
  }
  expect(externalCalls).toBe(2);
  expect(
    db.prepare("SELECT state FROM tool_invocations WHERE run_id=?").get(run.id),
  ).toEqual({ state: "unknown" });
  await expect(
    invokeTool(
      run,
      {
        name: "metrics",
        tool: "metrics",
        connectionId: c,
        description: "",
        inputSchema: {},
      },
      "manual-call",
      { query: "fail" },
    ),
  ).rejects.toThrow(/uncertain/);
  expect(externalCalls).toBe(2);
  const activities = db
    .prepare(
      "SELECT owner_id,run_id,record FROM agent_activities WHERE run_id=? AND kind='tool'",
    )
    .all(run.id) as { owner_id: string; run_id: string; record: string }[];
  expect(activities).toHaveLength(1);
  expect(activities[0]).toMatchObject({ owner_id: "alice", run_id: run.id });
  expect(JSON.parse(activities[0].record).data).toMatchObject({
    status: "unknown",
    error: expect.stringContaining("unknown"),
    links: { broker: "manual-call", trace: "tool:manual-call" },
  });
});
it("blocks private network URLs and preserves unrecognized results as readable fallback", () => {
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://169.254.169.254",
    "https://localhost",
    "https://2130706433",
    "https://10.0.0.1",
  ])
    expect(() => safeUrl(url)).toThrow();
  expect(publicAddress("::ffff:127.0.0.1")).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  const result = normalizeResult(
    { structuredContent: { unrecognized: [1, 2, 3] } },
    { connectionId: c, tool: "unknown", fetchedAt: now() },
  );
  expect(result.kind).toBe("markdown");
  expect(result.content).toContain("unrecognized");
});

it.each(["disabled connection", "expired approval"])(
  "keeps model credentials connected after an MCP %s",
  async (reason) => {
    db.prepare("UPDATE mcp_connections SET status='connected' WHERE id=?").run(
      c,
    );
    const run = submit("alice", {
      agentId: agent.id,
      input: "Request a tool",
      idempotencyKey: id(),
    });
    await tick(execute);
    const approval = db
      .prepare("SELECT * FROM approvals WHERE run_id=?")
      .get(run.id) as any;
    expect(approval.state).toBe("pending");
    decide("alice", approval.id, "approve");
    if (reason === "disabled connection")
      db.prepare("UPDATE mcp_connections SET status='disabled' WHERE id=?").run(
        c,
      );
    else
      db.prepare("UPDATE approvals SET expires_at=? WHERE id=?").run(
        now() - 1,
        approval.id,
      );
    const before = externalCalls;
    await tick(execute);
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual(
      { state: "failed" },
    );
    expect(externalCalls).toBe(before);
    expect(
      db.prepare("SELECT status FROM connections WHERE id=?").get(account),
    ).toEqual({ status: "connected" });
    const restore = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream() {
        yield { text: "Text still works" };
      },
    });
    try {
      const next = submit("alice", {
        agentId: agent.id,
        input: "Only text",
        idempotencyKey: id(),
      });
      await tick(execute);
      expect(
        db.prepare("SELECT state,result FROM runs WHERE id=?").get(next.id),
      ).toEqual({ state: "completed", result: "Text still works" });
    } finally {
      restore();
      db.prepare(
        "UPDATE mcp_connections SET status='connected' WHERE id=?",
      ).run(c);
    }
  },
);

it.each([
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft-07/schema#",
])(
  "accepts discovered %s schemas without skipping argument validation",
  (dialect) => {
    const original = connection().tools;
    const schema = {
      $schema: dialect,
      $id: "https://fixture.example/tool",
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    };
    try {
      db.prepare("UPDATE mcp_connections SET tools=? WHERE id=?").run(
        JSON.stringify([{ name: "browser_navigate", inputSchema: schema }]),
        c,
      );
      expect(
        authorizeTool("alice", agent.id, c, "browser_navigate", {
          url: "https://developers.openai.com/codex/models",
        }).tool.name,
      ).toBe("browser_navigate");
      expect(() =>
        authorizeTool("alice", agent.id, c, "browser_navigate", { url: 123 }),
      ).toThrow("arguments");
      expect(() =>
        authorizeTool("alice", agent.id, c, "browser_navigate", {
          url: "https://example.com",
          extra: true,
        }),
      ).toThrow("arguments");
      // Repeated calls and different tools may legitimately reuse a schema id.
      expect(() =>
        authorizeTool("alice", agent.id, c, "browser_navigate", {
          url: "https://example.com",
        }),
      ).not.toThrow();
      const modern = {
        ...schema,
        properties: { url: { const: "allowed" } },
        unevaluatedProperties: false,
      };
      db.prepare("UPDATE mcp_connections SET tools=? WHERE id=?").run(
        JSON.stringify([{ name: "browser_navigate", inputSchema: modern }]),
        c,
      );
      expect(() =>
        authorizeTool("alice", agent.id, c, "browser_navigate", {
          url: "blocked",
        }),
      ).toThrow("arguments");
    } finally {
      db.prepare("UPDATE mcp_connections SET tools=? WHERE id=?").run(
        original,
        c,
      );
    }
  },
);

it("runs repeated MCP calls automatically, records them, and restores prompting when the owner changes the preference", async () => {
  db.prepare("UPDATE mcp_connections SET status='connected' WHERE id=?").run(c);
  const before = externalCalls;
  setMcpApprovalMode("alice", "allow");
  expect(mcpApprovalMode("bob")).toBe("ask");
  try {
    for (let i = 0; i < 2; i++) {
      const run = submit("alice", {
        agentId: agent.id,
        input: "Automatic fixture tool",
        idempotencyKey: id(),
      });
      await tick(execute);
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "completed" });
      expect(
        db
          .prepare("SELECT state FROM tool_invocations WHERE run_id=?")
          .get(run.id),
      ).toEqual({ state: "completed" });
      expect(
        db.prepare("SELECT state FROM approvals WHERE run_id=?").get(run.id),
      ).toEqual({ state: "completed" });
      expect(
        db
          .prepare(
            "SELECT 1 FROM events WHERE run_id=? AND type='approval.requested'",
          )
          .get(run.id),
      ).toBeUndefined();
      expect(
        db
          .prepare(
            "SELECT 1 FROM events WHERE run_id=? AND type='approval.auto_approved'",
          )
          .get(run.id),
      ).toBeTruthy();
    }
    expect(externalCalls).toBe(before + 2);
    setMcpApprovalMode("alice", "ask");
    const waiting = submit("alice", {
      agentId: agent.id,
      input: "Ask again",
      idempotencyKey: id(),
    });
    await tick(execute);
    expect(
      db.prepare("SELECT state FROM runs WHERE id=?").get(waiting.id),
    ).toEqual({ state: "awaiting_approval" });
    expect(externalCalls).toBe(before + 2);
    expect(setMcpApprovalMode("alice", "allow").resumed).toBe(1);
    expect(setMcpApprovalMode("alice", "allow").resumed).toBe(0);
    await tick(execute);
    expect(
      db.prepare("SELECT state FROM runs WHERE id=?").get(waiting.id),
    ).toEqual({ state: "completed" });
    expect(externalCalls).toBe(before + 3);
  } finally {
    setMcpApprovalMode("alice", "ask");
  }
});

it("serializes a preference update with the worker's policy read and waiting transition", async () => {
  setMcpApprovalMode("alice", "ask");
  const writer = new Database(join(dir, "loop.db"));
  writer.pragma("busy_timeout = 0");
  let writerError: string | undefined;
  const snapshot = vi
    .spyOn(approvalPolicy, "mcpApprovalMode")
    .mockImplementationOnce((owner) => {
      const mode = mcpApprovalMode(owner);
      // A second process could otherwise commit Allow after the worker read Ask,
      // but before it created a waiting run for the preference updater to resume.
      try {
        writer
          .prepare(
            "UPDATE mcp_preferences SET approval_mode='allow' WHERE owner_id=?",
          )
          .run(owner);
      } catch (error) {
        writerError = (error as { code?: string }).code;
      }
      return mode;
    });
  try {
    const run = submit("alice", {
      agentId: agent.id,
      input: "Concurrent preference fixture",
      idempotencyKey: id(),
    });
    await tick(execute);
    expect(writerError).toBe("SQLITE_BUSY");
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual(
      { state: "awaiting_approval" },
    );
    snapshot.mockRestore();
    expect(setMcpApprovalMode("alice", "allow").resumed).toBe(1);
    await tick(execute);
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual(
      { state: "completed" },
    );
  } finally {
    snapshot.mockRestore();
    writer.close();
    setMcpApprovalMode("alice", "ask");
  }
});

it("preserves a received form error as text without claiming success or replaying the operation", async () => {
  setMcpApprovalMode("alice", "allow");
  const before = externalCalls;
  const run = queueTool("alice", {
    agentId: agent.id,
    connectionId: c,
    tool: "metrics",
    arguments: { query: "submission form" },
    idempotencyKey: id(),
  });
  await tick(execute);
  const invocation = db
    .prepare("SELECT * FROM tool_invocations WHERE run_id=?")
    .get(run.id) as any;
  const artifact = db
    .prepare("SELECT * FROM artifacts WHERE id=?")
    .get(invocation.artifact_id) as any;
  const meta = JSON.parse(artifact.metadata);
  expect(artifact.role).toBe("trace");
  expect(meta.appResource).toBeUndefined();
  expect(resourceReads).toBe(0);
  expect(meta.toolResult).toMatchObject({
    isError: true,
    structuredContent: { status: "awaiting_user_submission" },
  });
  expect(meta.isError).toBe(true);
  expect(invocation.state).toBe("failed");
  const cached = await invokeTool(
    run,
    toolBindings("alice", agent.id)[0],
    "manual-call",
    { query: "submission form" },
  );
  expect(cached).toMatchObject({
    artifactId: artifact.id,
    result: { isError: true },
  });
  expect(externalCalls).toBe(before + 1);
});

it("negotiates production connections without interactive app capabilities", async () => {
  resetMcp();
  const server = new McpServer({ name: "capabilities fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const original = Client.prototype.connect;
  const transport = vi
    .spyOn(Client.prototype, "connect")
    .mockImplementation(function (this: Client, _transport, options) {
      return original.call(this, b, options);
    });
  let client: Client | undefined;
  try {
    client = await connect(connection());
    expect(
      server.server.getClientCapabilities()?.extensions?.[
        "io.modelcontextprotocol/ui"
      ],
    ).toBeUndefined();
    expect(server.server.getClientVersion()?.name).toBe("loop");
  } finally {
    transport.mockRestore();
    await client?.close();
    await server.close();
    withTestMcp(fixtureMcp);
  }
});

it("marks connected tools deferred for the provider and replays its ordered tool search content after an approval pause", async () => {
  const seen: any[] = [];
  // The documented interleaved shape, kept as one ordered sequence.
  const providerContent: any[] = [
    { type: "text", text: "Searching. " },
    {
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "tool_search_tool_bm25",
      input: { query: "latency" },
      caller: { type: "direct" },
    },
    {
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: { type: "tool_search_tool_search_result", tool_references: [] },
    },
    { type: "text", text: "Found it." },
    { type: "tool_use", id: "call-search-1", name: "pending", input: {} },
  ];
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      seen.push(input);
      if (!input.messages.some((m) => m.role === "tool")) {
        const name = input.tools!.find((t) => t.deferLoading)!.name;
        providerContent[4] = { ...providerContent[4], name };
        yield { text: "Searching. " };
        yield { text: "Found it." };
        yield {
          toolCall: {
            id: "call-search-1",
            name,
            arguments: { query: "fixture latency" },
          },
        };
        yield { providerContent };
      } else yield { text: "Latency from a discovered tool." };
    },
  });
  try {
    const run = submit("alice", {
      agentId: agent.id,
      input: "Latency through search",
      idempotencyKey: id(),
    });
    await tick(execute);
    const state = () =>
      (db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as any)
        .state;
    if (state() === "awaiting_approval") {
      const approval = db
        .prepare("SELECT id FROM approvals WHERE run_id=? AND state='pending'")
        .get(run.id) as any;
      decide("alice", approval.id, "approve");
      await tick(execute);
    }
    expect(state()).toBe("completed");
    expect(seen).toHaveLength(2);
    // Loop's own tools stay loaded; every connected MCP tool is deferred.
    const flags = new Map(
      seen[0].tools.map((t: any) => [t.name, t.deferLoading]),
    );
    expect(flags.get("loop_plan")).toBe(false);
    expect(flags.get("loop_publish_file")).toBe(false);
    expect(
      seen[0].tools
        .filter((t: any) => t.deferLoading)
        .map((t: any) => t.description),
    ).toEqual(["Fixture MCP metrics: Fixture metrics. No real Datadog data."]);
    // The checkpoint carried the ordered content across the approval pause,
    // alongside Loop's own text and tool-call record of the same turn.
    const assistant = seen[1].messages.find(
      (m: any) => m.role === "assistant" && m.toolCalls?.length,
    );
    expect(assistant).toEqual({
      role: "assistant",
      content: "Searching. Found it.",
      toolCalls: [
        {
          id: "call-search-1",
          name: providerContent[4].name,
          arguments: { query: "fixture latency" },
        },
      ],
      providerContent,
    });
    expect(seen[1].messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-search-1",
    });
  } finally {
    restore();
  }
});

it("continues a paused provider turn with its content replayed, and fails after repeated pauses", async () => {
  const seen: any[] = [];
  const pausedContent = [
    { type: "thinking", thinking: "", signature: "sig" },
    {
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "tool_search_tool_bm25",
      input: { query: "latency" },
    },
    {
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: { type: "tool_search_tool_search_result", tool_references: [] },
    },
  ];
  let pauseForever = false;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      seen.push(input);
      const paused = input.messages.filter(
        (m) => m.role === "assistant" && m.providerContent,
      ).length;
      if (pauseForever || paused === 0)
        yield { providerContent: pausedContent, pauseTurn: true };
      else yield { text: "Latency after the provider resumed." };
    },
  });
  try {
    const run = submit("alice", {
      agentId: agent.id,
      input: "Latency with a paused search",
      idempotencyKey: id(),
    });
    await tick(execute);
    expect(
      db.prepare("SELECT state,result FROM runs WHERE id=?").get(run.id),
    ).toEqual({
      state: "completed",
      result: "Latency after the provider resumed.",
    });
    expect(seen).toHaveLength(2);
    // No tool result is invented: the paused turn is simply the last message.
    expect(seen[1].messages.at(-1)).toEqual({
      role: "assistant",
      content: "",
      providerContent: pausedContent,
      paused: true,
    });
    pauseForever = true;
    const stuck = submit("alice", {
      agentId: agent.id,
      input: "Never answers",
      idempotencyKey: id(),
    });
    await tick(execute);
    expect(
      db.prepare("SELECT state,error FROM runs WHERE id=?").get(stuck.id),
    ).toMatchObject({
      state: "failed",
      error: expect.stringContaining("paused its turn too many times"),
    });
    expect(seen.length - 2).toBe(9);
  } finally {
    restore();
  }
});

it("keeps the pause cap across an approval pause that re-enters the run", async () => {
  const pausedContent = [
    {
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "tool_search_tool_bm25",
      input: { query: "latency" },
    },
    {
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: { type: "tool_search_tool_search_result", tool_references: [] },
    },
  ];
  let requests = 0;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      requests++;
      const paused = input.messages.filter((m) => m.paused).length;
      const answered = input.messages.some((m) => m.role === "tool");
      // Eight pauses, then a client tool call that needs approval, then a
      // ninth pause after the run re-enters: the cap must still apply.
      if (paused < 8) yield { providerContent: pausedContent, pauseTurn: true };
      else if (!answered)
        yield {
          toolCall: {
            id: "call-cap-1",
            name: input.tools!.find((t) => t.deferLoading)!.name,
            arguments: { query: "fixture latency" },
          },
        };
      else yield { providerContent: pausedContent, pauseTurn: true };
    },
  });
  const previousMode = approvalPolicy.mcpApprovalMode("alice");
  approvalPolicy.setMcpApprovalMode("alice", "ask");
  try {
    const run = submit("alice", {
      agentId: agent.id,
      input: "Pause cap across approval",
      idempotencyKey: id(),
    });
    await tick(execute);
    expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual(
      {
        state: "awaiting_approval",
      },
    );
    const approval = db
      .prepare("SELECT id FROM approvals WHERE run_id=? AND state='pending'")
      .get(run.id) as any;
    decide("alice", approval.id, "approve");
    await tick(execute);
    expect(
      db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
    ).toMatchObject({
      state: "failed",
      error: expect.stringContaining("paused its turn too many times"),
    });
    expect(requests).toBe(10);
  } finally {
    approvalPolicy.setMcpApprovalMode("alice", previousMode);
    restore();
  }
});
