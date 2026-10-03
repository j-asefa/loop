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
const { withTestMcp, discover } = await import("../src/server/mcp/client");
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
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><p>Fixture app</p>",
        },
      ],
    }),
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
it("uses official MCP discovery, pauses model tool calls for approval and saves exact native data plus app resource", async () => {
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
  expect(JSON.parse(artifact.metadata).appResource.html).toContain(
    "Fixture app",
  );
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

it("retains an app form on a received error without claiming success or replaying the operation", async () => {
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
  expect(meta.appResource.html).toContain("Fixture app");
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
