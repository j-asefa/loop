import { it, expect, afterAll } from "vitest";
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
const { setGrants, queueTool } = await import("../src/server/mcp/routes");
const { authorizeTool, invokeTool } = await import("../src/server/mcp/broker");
const { decide } = await import("../src/server/approvals");
const { submit } = await import("../src/server/agent-runtime");
const { tick, execute } = await import("../src/server/worker");
const { normalizeResult } = await import("../src/server/mcp/results");
let externalCalls = 0,
  fail = false;
const resetMcp = withTestMcp(async () => {
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
    async () => {
      externalCalls++;
      if (fail) throw new Error("Fixture network uncertainty");
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
});
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
const grants = [{ connectionId: c, tools: ["metrics"] }];
setGrants("alice", agent.id, grants);
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
it("enforces same grant and schema checks on UI calls, and revocation after approval prevents external execution", async () => {
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
    idempotencyKey: "revoke-grant-test",
  });
  await tick(execute);
  const approval = db
    .prepare("SELECT * FROM approvals WHERE run_id=?")
    .get(run.id) as any;
  decide("alice", approval.id, "approve");
  setGrants("alice", agent.id, []);
  await tick(execute);
  expect(externalCalls).toBe(1);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "failed",
  });
  setGrants("alice", agent.id, grants);
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
  fail = true;
  await tick(execute);
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

it.each(["revoked grant", "expired approval"])(
  "keeps model credentials connected after an MCP %s",
  async (reason) => {
    setGrants("alice", agent.id, grants);
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
    if (reason === "revoked grant") setGrants("alice", agent.id, []);
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
      setGrants("alice", agent.id, grants);
    }
  },
);
