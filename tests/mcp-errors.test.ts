import { afterAll, expect, it } from "vitest";
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
const { db, id, now } = await import("../src/server/db");
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
const { feedUpdates } = await import("../src/server/feed");

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
      const feed = feedUpdates("alice", {
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
