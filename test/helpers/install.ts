import { Problem } from "../../src/server/domain";
// Explicit test entrypoints only. No HTTP route enables these adapters.
import { z } from "zod";
import { ownInstructions } from "./instructions";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withTestAdapter } from "../../src/server/providers";
import { db } from "../../src/server/db";
import { withTestMcp } from "../../src/server/mcp/client";
if (process.env.NODE_ENV !== "test")
  throw new Error("Fixtures require NODE_ENV=test");
for (const provider of ["openai", "anthropic"] as const)
  withTestAdapter(provider, {
    async models(key) {
      if (provider === "openai" && key === "fixture-workspace-models")
        return [
          { id: "gpt-6-sol", name: "GPT-6 Sol", capabilities: "Fixture only" },
          {
            id: "gpt-6-astra",
            name: "GPT-6 Astra",
            capabilities: "Fixture only",
            effortLevels: [
              { value: "low" },
              {
                value: "xhigh",
                description: "Take more time to check difficult work.",
              },
            ],
            defaultEffort: "low",
          },
        ];
      return [
        {
          id: provider + "-fixture",
          name: provider + " deterministic fixture",
          capabilities: "Fixture only",
        },
      ];
    },
    async *stream(_key, input) {
      if (input.messages.at(-1)?.content === "failure-visibility-fixture")
        throw new Problem(422, "Tool input schema is unsupported");
      if (
        input.messages.some((m) =>
          m.content.startsWith("approval-navigation-fixture"),
        ) &&
        !input.messages.some((m) => m.role === "tool")
      ) {
        yield {
          toolCall: {
            id: "navigation-fixture",
            name: input.tools!.find((t) =>
              t.description.includes("Browser navigation fixture"),
            )!.name,
            arguments: {
              url: "https://example.com/search?q=Codex+shared+context+and+skills&source=approval-review-fixture-with-a-long-readable-target",
            },
          },
        };
        return;
      }
      if (
        input.instructions?.startsWith("fixture-team:") &&
        !input.messages.some((m) => m.role === "tool")
      ) {
        yield {
          toolCall: {
            id: "fixture-delegation",
            name: "loop_delegate",
            arguments: {
              tasks: [
                {
                  agentId: ownInstructions(input.instructions).slice(13),
                  input: "Collect evidence for the team",
                },
              ],
            },
          },
        };
        return;
      }
      if (
        input.tools?.length &&
        input.messages.some((m) => /latency/i.test(m.content)) &&
        !input.messages.some((m) => m.role === "tool")
      ) {
        yield {
          toolCall: {
            id: "fixture-call",
            name: input.tools[0].name,
            arguments: { query: "fixture latency" },
          },
        };
        return;
      }
      yield { text: "Fixture response: " };
      await new Promise((r) =>
        setTimeout(
          r,
          input.messages.at(-1)?.content.includes("disconnect-check")
            ? 800
            : 80,
        ),
      );
      yield {
        text: "Bids are resting buy orders. This is deterministic fixture content, not a live model response.",
      };
    },
  });
withTestMcp(async (c) => {
  c.metadata = JSON.stringify({ ...JSON.parse(c.metadata), fixture: true });
  db.prepare("UPDATE mcp_connections SET metadata=? WHERE id=?").run(
    c.metadata,
    c.id,
  );
  const server = new McpServer({ name: "Loop browser fixture", version: "1" });
  server.registerTool(
    "metrics",
    {
      description: "Fixture metric query",
      inputSchema: { query: z.string() },
      _meta: { ui: { resourceUri: "ui://fixture/app" } },
    },
    async () => ({
      content: [{ type: "text", text: "Deterministic fixture metrics" }],
      structuredContent: {
        type: "timeseries",
        title: "Fixture request latency",
        timezone: "UTC",
        range: { from: 1700000000000, to: 1700000120000 },
        series: [
          {
            name: "Fixture latency",
            unit: "ms",
            points: [
              [1700000000000, 12],
              [1700000060000, null],
              [1700000120000, 18],
            ],
          },
        ],
        source: { fixture: true },
      },
    }),
  );
  server.registerTool(
    "browser_navigate",
    {
      description: "Browser navigation fixture",
      inputSchema: { url: z.string() },
    },
    async () => ({
      content: [{ type: "text", text: "Fixture navigation complete" }],
    }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "loop-browser-test", version: "1" });
  await client.connect(b);
  return client;
});
