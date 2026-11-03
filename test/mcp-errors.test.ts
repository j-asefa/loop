import express from "express";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const dir = mkdtempSync(join(tmpdir(), "loop-mcp-errors-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now, changes } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { withTestAdapter } = await import("../src/server/providers");
const { submit } = await import("../src/server/agent-runtime");
const { tick, execute } = await import("../src/server/worker");
const { withTestMcp, discover } = await import("../src/server/mcp/client");
const { invokeTool, toolBindings } = await import("../src/server/mcp/broker");
const { queueTool } = await import("../src/server/mcp/routes");
const { setMcpApprovalMode } =
  await import("../src/server/mcp/approval-policy");
const { decide } = await import("../src/server/approvals");
const { normalizeResult, toolErrorMessage } =
  await import("../src/server/mcp/results");
const { resultsUpdates } = await import("../src/server/results");

const account = id(),
  connection = id();
const token = 'fixture-secret-"key+/ &\\ end';
const rejection = "Review Can not request changes on your own pull request";
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Fixture',?,'connected',?,?)",
).run(
  account,
  seal("fixture", "alice"),
  JSON.stringify([{ id: "fixture" }]),
  now(),
);
const agent = createAgent("alice", {
  name: "review-error-fixture",
  connectionId: account,
  model: "fixture",
});
db.prepare(
  "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,'alice','Review fixture','https://fixture.example/mcp',?,'connected','{}',?)",
).run(
  connection,
  seal(JSON.stringify({ type: "bearer", token }), "alice"),
  now(),
);

let writes: { method: string; event?: string }[] = [],
  draft = false;
const restoreMcp = withTestMcp(async () => {
  const server = new McpServer({ name: "review-errors-fixture", version: "1" });
  server.registerTool(
    "pull_request_review_write",
    {
      inputSchema: {
        method: z.enum(["create", "submit_pending"]),
        event: z.enum(["COMMENT", "REQUEST_CHANGES"]).optional(),
      },
    },
    async (args) => {
      writes.push(args);
      if (args.method === "create") {
        if (draft)
          return {
            isError: true,
            content: [
              { type: "text", text: "A pending review already exists" },
            ],
          };
        draft = true;
      } else if (args.event === "REQUEST_CHANGES") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `${rejection}. Diagnostic credential: ${token}`,
            },
          ],
        };
      } else {
        if (!draft) throw new Error("Pending review is missing");
        draft = false;
      }
      return {
        content: [
          {
            type: "text",
            text:
              args.method === "create"
                ? "Pending review 733"
                : "Review 733 submitted as a comment",
          },
        ],
      };
    },
  );
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  const client = new Client({ name: "fixture", version: "1" });
  await client.connect(right);
  return client;
});
await discover(
  db.prepare("SELECT * FROM mcp_connections WHERE id=?").get(connection) as any,
);
afterAll(() => {
  restoreMcp();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it.each(["ask", "allow"] as const)(
  "lets the model recover from a received GitHub rejection with %s approvals, without replaying writes",
  async (mode) => {
    writes = [];
    draft = false;
    setMcpApprovalMode("alice", mode);
    const restoreProvider = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream(_key, input) {
        const results = input.messages.filter((m) => m.role === "tool");
        if (results.length >= 2) {
          expect(results[1].isError).toBe(true);
          expect(JSON.parse(results[1].content)).toMatchObject({
            isError: true,
          });
          expect(results[1].content).toContain(rejection);
          expect(results[1].content).toContain("[redacted]");
          expect(results[1].content).not.toContain(token);
        }
        if (results.length === 3) {
          expect(results[2].isError).toBe(false);
          yield { text: "Your existing review was submitted as a comment." };
          return;
        }
        yield {
          toolCall: {
            id: "review-" + results.length,
            name: input.tools!.find((t) => t.name.startsWith("loop_tool_"))!
              .name,
            arguments:
              results.length === 0
                ? { method: "create" }
                : {
                    method: "submit_pending",
                    event: results.length === 1 ? "REQUEST_CHANGES" : "COMMENT",
                  },
          },
        };
      },
    });
    try {
      const run = submit("alice", {
        agentId: agent.id,
        input: "Post the review; submit a comment if reviewing your own PR",
        idempotencyKey: id(),
      });
      for (let i = 0; i < 4; i++) {
        await tick(execute);
        const approval = db
          .prepare(
            "SELECT id FROM approvals WHERE run_id=? AND state='pending'",
          )
          .get(run.id) as any;
        if (!approval) break;
        decide("alice", approval.id, "approve");
      }
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "completed" });
      expect(writes).toEqual([
        { method: "create" },
        { method: "submit_pending", event: "REQUEST_CHANGES" },
        { method: "submit_pending", event: "COMMENT" },
      ]);
      const failed = db
        .prepare(
          "SELECT * FROM tool_invocations WHERE run_id=? AND call_id='review-1'",
        )
        .get(run.id) as any;
      expect(failed.state).toBe("failed");
      expect(JSON.parse(failed.result).isError).toBe(true);
      const trace = db
        .prepare(
          "SELECT * FROM run_traces WHERE run_id=? AND trace_key='tool:review-1'",
        )
        .get(run.id) as any;
      expect(trace.content).toContain(rejection);
      expect(JSON.parse(trace.metadata)).toMatchObject({
        state: "failed",
        isError: true,
      });
      const artifact = db
        .prepare("SELECT * FROM artifacts WHERE id=?")
        .get(failed.artifact_id) as any;
      expect(artifact.title).toBe("pull_request_review_write error");
      expect(artifact.content).toContain(rejection);
      for (const table of [
        "tool_invocations",
        "run_traces",
        "artifacts",
        "agent_checkpoints",
        "events",
      ]) {
        const stored = JSON.stringify(
          db.prepare(`SELECT * FROM ${table} WHERE run_id=?`).all(run.id),
        );
        expect(stored).not.toContain(JSON.stringify(token).slice(1, -1));
      }
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM events WHERE run_id=? AND type='tool.failed'",
          )
          .get(run.id),
      ).toEqual({ n: 1 });
      const cached = await invokeTool(
        run,
        toolBindings("alice", agent.id)[0],
        "review-1",
        { method: "submit_pending", event: "REQUEST_CHANGES" },
      );
      expect(cached).toMatchObject({
        result: { isError: true },
        artifactId: failed.artifact_id,
      });
      expect(writes).toHaveLength(3);
      const feed = resultsUpdates("alice", {
        after: 0,
        through: 0,
        agent: agent.id,
      }).items as any[];
      expect(
        feed
          .filter((item) => item.run_id === run.id)
          .map((item) => item.content),
      ).toEqual(["Your existing review was submitted as a comment."]);
    } finally {
      restoreProvider();
    }
  },
);

it("shows the redacted, specific error for a direct tool run and retains its received result", async () => {
  writes = [];
  draft = true;
  setMcpApprovalMode("alice", "allow");
  const run = queueTool("alice", {
    agentId: agent.id,
    connectionId: connection,
    tool: "pull_request_review_write",
    arguments: { method: "submit_pending", event: "REQUEST_CHANGES" },
    idempotencyKey: id(),
  });
  await tick(execute);
  const saved = db
    .prepare("SELECT state,error,result FROM runs WHERE id=?")
    .get(run.id) as any;
  expect(saved.state).toBe("failed");
  expect(saved.error).toContain(rejection);
  expect(saved.error).toContain("[redacted]");
  expect(saved.error).not.toContain(token);
  expect(JSON.parse(saved.result).artifactId).toBeTruthy();
  expect(
    db.prepare("SELECT state FROM tool_invocations WHERE run_id=?").get(run.id),
  ).toEqual({ state: "failed" });
  expect(
    db.prepare("SELECT state FROM approvals WHERE run_id=?").get(run.id),
  ).toEqual({ state: "completed" });
  expect(writes).toHaveLength(1);
  expect(draft).toBe(true);
});

it("keeps structured errors readable and bounds the short explanation", () => {
  const result = {
    isError: true,
    structuredContent: { error: "Pending review already exists" },
  };
  expect(toolErrorMessage(result)).toContain("Pending review already exists");
  expect(
    normalizeResult(result, {
      connectionId: connection,
      tool: "review",
      fetchedAt: now(),
    }),
  ).toMatchObject({
    kind: "markdown",
    title: "review error",
    content: expect.stringContaining("Pending review already exists"),
  });
  expect(toolErrorMessage({ isError: true })).toBe(
    "The tool returned an error without details.",
  );
  expect(
    toolErrorMessage({ content: [{ type: "text", text: "x".repeat(3000) }] }),
  ).toHaveLength(2000);
});

it("preserves the failed tool, transport code and redacted cause without replaying an uncertain call", async () => {
  const { McpError, ErrorCode } =
    await import("@modelcontextprotocol/sdk/types.js");
  const { MCP_TOOL_TIMEOUT_MS } = await import("../src/server/mcp/timeouts");
  setMcpApprovalMode("alice", "allow");
  let requests = 0;
  const restore = withTestMcp(
    async () =>
      ({
        async callTool(_input: unknown, _schema: unknown, options: any) {
          expect(options.timeout).toBe(MCP_TOOL_TIMEOUT_MS);
          expect(options.timeout).toBeGreaterThan(30000);
          requests++;
          throw new McpError(
            ErrorCode.RequestTimeout,
            `Navigation did not finish; ${token} https://fixture.example/?access_token=private-query`,
          );
        },
        async close() {},
      }) as unknown as Client,
  );
  const run = queueTool("alice", {
    agentId: agent.id,
    connectionId: connection,
    tool: "pull_request_review_write",
    arguments: { method: "create" },
    idempotencyKey: id(),
  });
  try {
    await tick(execute);
    const stored = db
      .prepare("SELECT state,error FROM runs WHERE id=?")
      .get(run.id) as any;
    expect(stored.state).toBe("failed");
    expect(stored.error).toContain(
      "Review fixture · pull_request_review_write",
    );
    expect(stored.error).toContain("Navigation did not finish");
    expect(stored.error).toContain("external outcome is unknown");
    const invocation = db
      .prepare("SELECT * FROM tool_invocations WHERE run_id=?")
      .get(run.id) as any;
    expect(invocation.state).toBe("unknown");
    expect(JSON.parse(invocation.result).failure).toMatchObject({
      phase: "calling",
      outcome: "unknown",
      code: ErrorCode.RequestTimeout,
    });
    const traces = db
      .prepare("SELECT * FROM run_traces WHERE run_id=?")
      .all(run.id) as any[];
    expect(
      traces.find((t) => t.title === "pull_request_review_write")?.content,
    ).toContain("Navigation did not finish");
    expect(traces.find((t) => t.title === "Run failure")?.content).toBe(
      stored.error,
    );
    expect(
      JSON.stringify({ stored, invocation: invocation.result, traces }),
    ).not.toContain(token);
    expect(JSON.stringify(traces)).not.toContain("private-query");
    await expect(
      invokeTool(
        run,
        toolBindings("alice", agent.id).find(
          (b) => b.connectionId === connection,
        )!,
        invocation.call_id,
        { method: "create" },
      ),
    ).rejects.toThrow(/uncertain/);
    expect(requests).toBe(1);
  } finally {
    restore();
  }
});

it.each([true, false])(
  "cancels in-flight MCP IO through the route without replay (bus=%s)",
  async (enabled) => {
    const { core } = await import("../src/server/core-routes");
    const app = express();
    app.use(express.json(), (_req, res, next) => {
      res.locals.owner = "alice";
      next();
    });
    app.use(core);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const bus = enabled
      ? undefined
      : vi.spyOn(changes, "subscribe").mockImplementation(() => () => {});
    setMcpApprovalMode("alice", "allow");
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = false;
    const restore = withTestMcp(
      async () =>
        ({
          callTool(_input: unknown, _schema: unknown, options: any) {
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => {
                  cancelled = true;
                  reject(new Error("Cancelled by user"));
                },
                { once: true },
              );
              started();
            });
          },
          async close() {},
        }) as unknown as Client,
    );
    const run = queueTool("alice", {
      agentId: agent.id,
      connectionId: connection,
      tool: "pull_request_review_write",
      arguments: { method: "create" },
      idempotencyKey: id(),
    });
    try {
      const work = tick(execute);
      await waiting;
      const at = Date.now();
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as any).port}/runs/${run.id}/cancel`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      await work;
      expect(cancelled).toBe(true);
      expect(Date.now() - at).toBeLessThan(enabled ? 700 : 2300);
      const failure = db
        .prepare("SELECT result FROM tool_invocations WHERE run_id=?")
        .get(run.id) as { result: string };
      expect(JSON.parse(failure.result)).toMatchObject({
        failure: { phase: "calling", outcome: "unknown" },
      });
      expect(failure.result).toContain("cancelled");
      expect(
        db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
      ).toEqual({ state: "cancelled", error: null });
      expect(
        db
          .prepare("SELECT state FROM tool_invocations WHERE run_id=?")
          .get(run.id),
      ).toEqual({ state: "unknown" });
      expect(
        db
          .prepare(
            "SELECT id FROM run_traces WHERE run_id=? AND trace_key='run:failure'",
          )
          .get(run.id),
      ).toBeUndefined();
    } finally {
      bus?.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      restore();
    }
  },
);
