// Explicit test entrypoints only. No HTTP route enables these adapters.
import { readFileSync } from "node:fs";
import { z } from "zod";
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
    async models() {
      return [
        {
          id: provider + "-fixture",
          name: provider + " deterministic fixture",
          capabilities: "Fixture only",
        },
      ];
    },
    async *stream(_key, input) {
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
  server.registerResource(
    "app",
    "ui://fixture/app",
    { mimeType: "text/html;profile=mcp-app" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: `<!doctype html><html><head><meta charset="utf-8"></head><body><h2>Fixture MCP app</h2><p id="status">Connecting…</p><button id="allowed">Approved tool request</button><button id="denied">Denied tool request</button><button id="parent">Try parent access</button><button id="link">Try unsupported capability</button><p id="denial"></p><p id="isolation"></p><p id="capability"></p><script>${readFileSync(process.env.LOOP_FIXTURE_APP!, "utf8").replaceAll("</script", "<\\/script")}</script></body></html>`,
        },
      ],
    }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "loop-browser-test", version: "1" });
  await client.connect(b);
  return client;
});
