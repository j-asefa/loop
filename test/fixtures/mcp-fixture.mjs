// Test-only local MCP process. Never selected or packaged by production.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "fixture-workspace-mcp", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fixture_echo",
      description: "Echo fixture evidence",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    { type: "text", text: "MCP result " + request.params.arguments.text },
  ],
}));
await server.connect(new StdioServerTransport());
