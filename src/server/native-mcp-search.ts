import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolBinding } from "./mcp/broker.js";
import { compactJsonSchema } from "./native-tools.js";

export const MCP_SEARCH_TOOL = "loop_mcp_search";
export const MCP_CALL_TOOL = "loop_mcp_call";

const SERVER_SUMMARY_MAX_CHARS = 240;
const SEARCH_RESPONSE_MAX_BYTES = 28_000;
const SEARCH_DESCRIPTION_MAX_CHARS = 500;

export const mcpSearchInput = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe("Keywords matching server, tool name, or description."),
  server: z
    .string()
    .max(120)
    .optional()
    .describe("Filter by connected server name."),
  limit: z.number().int().min(1).max(25).default(10),
  offset: z.number().int().nonnegative().default(0),
});

export const mcpCallInput = z.object({
  toolId: z
    .string()
    .min(1)
    .max(120)
    .describe("toolId from loop_mcp_search (e.g. loop_mcp_...)."),
  arguments: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Arguments matching the tool's inputSchema."),
});

export function externalToolName(connectionId: string, tool: string): string {
  return (
    "loop_mcp_" +
    createHash("sha256")
      .update(connectionId + ":" + tool)
      .digest("hex")
      .slice(0, 20)
  );
}

function bindingServer(binding: ToolBinding): string {
  if (binding.server) return binding.server;
  const prefix = binding.description.split(" ", 1)[0];
  return prefix || binding.connectionId;
}

function summarizeServers(bindings: ToolBinding[]): {
  counts: Array<{ name: string; tools: number }>;
  text: string;
} {
  const byServer = new Map<string, number>();
  for (const binding of bindings) {
    const name = bindingServer(binding);
    byServer.set(name, (byServer.get(name) || 0) + 1);
  }
  const counts = [...byServer.entries()]
    .map(([name, tools]) => ({ name, tools }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!counts.length) return { counts, text: "none connected" };

  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < counts.length; i++) {
    const entry = `${counts[i].name} (${counts[i].tools})`;
    const sep = parts.length ? ", " : "";
    const remaining = counts.length - i;
    const overflowSuffix = `, +${remaining} more`;
    if (
      parts.length > 0 &&
      used +
        sep.length +
        entry.length +
        (remaining > 1 ? overflowSuffix.length : 0) >
        SERVER_SUMMARY_MAX_CHARS
    ) {
      parts.push(`+${remaining} more`);
      break;
    }
    parts.push(entry);
    used += sep.length + entry.length;
  }
  return { counts, text: parts.join(", ") };
}

/**
 * Compact on-demand discovery and dispatch tools for harnesses whose eager
 * MCP byte budget would otherwise drop Loop's own tools or larger integrations
 * (such as Antigravity ACP's 64 KiB eager tool schema budget).
 */
export function deferredMcpMetaBindings(
  external: ToolBinding[],
): ToolBinding[] {
  const { text } = summarizeServers(external);
  return [
    {
      name: MCP_SEARCH_TOOL,
      tool: MCP_SEARCH_TOOL,
      connectionId: "__loop__",
      description: `Search connected workspace MCP tools and return toolId, description, and inputSchema for ${MCP_CALL_TOOL}. Omit query/server to browse. Servers: ${text}.`,
      inputSchema: compactJsonSchema(z.toJSONSchema(mcpSearchInput)) as Record<
        string,
        unknown
      >,
    },
    {
      name: MCP_CALL_TOOL,
      tool: MCP_CALL_TOOL,
      connectionId: "__loop__",
      description: `Call a connected workspace MCP tool found via ${MCP_SEARCH_TOOL}. Pass toolId and arguments; follows workspace MCP approval policy.`,
      inputSchema: compactJsonSchema(z.toJSONSchema(mcpCallInput)) as Record<
        string,
        unknown
      >,
    },
  ];
}

function splitWords(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function tokenize(text: string): string[] {
  return splitWords(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function scoreBinding(
  binding: ToolBinding,
  rawQuery: string,
  tokens: string[],
): { matched: number; score: number } {
  const server = splitWords(bindingServer(binding));
  const toolRaw = binding.tool.toLowerCase();
  const toolWords = splitWords(binding.tool);
  const desc = splitWords(binding.description);
  const haystack = `${server} ${toolRaw} ${toolWords} ${desc}`;
  let matched = 0;
  let score = 0;
  if (toolRaw === rawQuery || toolWords === rawQuery) score += 100;
  else if (toolRaw.includes(rawQuery) || toolWords.includes(rawQuery))
    score += 40;
  if (server === rawQuery) score += 30;
  for (const token of tokens) {
    let hit = false;
    if (toolRaw === token || toolWords === token) {
      score += 30;
      hit = true;
    } else if (toolRaw.includes(token) || toolWords.includes(token)) {
      score += 15;
      hit = true;
    }
    if (server.includes(token)) {
      score += 12;
      hit = true;
    }
    if (desc.includes(token)) {
      score += 4;
      hit = true;
    }
    if (!hit && haystack.includes(token)) {
      score += 1;
      hit = true;
    }
    if (hit) matched += 1;
  }
  return { matched, score };
}

export function searchExternalBindings(
  bindings: ToolBinding[],
  rawArgs: unknown,
) {
  const input = mcpSearchInput.parse(rawArgs || {});
  const { counts: servers } = summarizeServers(bindings);
  const serverFilter = input.server?.trim().toLowerCase() || "";
  const queryRaw = input.query?.trim().toLowerCase() || "";
  const tokens = queryRaw ? tokenize(queryRaw) : [];

  const filtered = serverFilter
    ? bindings.filter((b) =>
        bindingServer(b).toLowerCase().includes(serverFilter),
      )
    : bindings;

  const sortAlpha = (a: ToolBinding, b: ToolBinding) =>
    bindingServer(a).localeCompare(bindingServer(b)) ||
    a.tool.localeCompare(b.tool) ||
    a.name.localeCompare(b.name);

  let ordered: ToolBinding[];
  if (!tokens.length) {
    ordered = [...filtered].sort(sortAlpha);
  } else {
    const scored = filtered
      .map((binding) => ({
        binding,
        ...scoreBinding(binding, queryRaw, tokens),
      }))
      .filter((entry) => entry.matched > 0);
    const allTokens = scored.filter((entry) => entry.matched === tokens.length);
    const pool = allTokens.length ? allTokens : scored;
    ordered = pool
      .sort(
        (a, b) =>
          b.matched - a.matched ||
          b.score - a.score ||
          sortAlpha(a.binding, b.binding),
      )
      .map((entry) => entry.binding);
  }

  const total = ordered.length;
  const window = ordered.slice(input.offset, input.offset + input.limit);
  const tools: Array<{
    toolId: string;
    server: string;
    tool: string;
    description: string;
    inputSchema: unknown;
  }> = [];

  const basePayload = {
    servers,
    total,
    offset: input.offset,
    nextOffset: null as number | null,
    tools,
  };

  for (const binding of window) {
    const entry = {
      toolId: binding.name,
      server: bindingServer(binding),
      tool: binding.tool,
      description: binding.description.slice(0, SEARCH_DESCRIPTION_MAX_CHARS),
      inputSchema: compactJsonSchema(binding.inputSchema),
    };
    const nextSize = Buffer.byteLength(
      JSON.stringify({ ...basePayload, tools: [...tools, entry] }),
      "utf8",
    );
    if (nextSize > SEARCH_RESPONSE_MAX_BYTES && tools.length > 0) break;
    tools.push(entry);
  }

  const nextOffset =
    input.offset + tools.length < total ? input.offset + tools.length : null;
  return {
    servers,
    total,
    offset: input.offset,
    nextOffset,
    tools,
  };
}
