import { db } from "../db.js";
import { Problem } from "../domain.js";

export type ToolBinding = {
  name: string;
  connectionId: string;
  tool: string;
  description: string;
  inputSchema: any;
};
// Leave room for Loop's internal tools and message history in provider/host
// requests. These limits apply only to Loop's attached MCP catalog, never to
// the native Codex/Claude tools on a remote host.
export const MCP_TOOL_BUDGET = { count: 120, bytes: 400_000 };
export class ToolBudgetError extends Problem {
  constructor() {
    super(
      422,
      "Workspace tools exceed the per-request catalog budget (120 tools / 400 KB). Disable unused integrations in Settings → Tools & integrations, or configure a smaller toolset, then reconnect.",
    );
  }
}
type Catalog = { id: string; name: string; tools: string };
export function workspaceToolBindings(
  owner: string,
  candidate?: Catalog,
): ToolBinding[] {
  const rows = db
    .prepare(
      "SELECT id,name,tools FROM mcp_connections WHERE owner_id=? AND status='connected' ORDER BY id",
    )
    .all(owner) as Catalog[];
  const catalogs = candidate
    ? [...rows.filter((row) => row.id !== candidate.id), candidate].sort(
        (a, b) => a.id.localeCompare(b.id),
      )
    : rows;
  const result: ToolBinding[] = [];
  for (const row of catalogs) {
    for (const tool of JSON.parse(row.tools)) {
      if (result.length >= MCP_TOOL_BUDGET.count) throw new ToolBudgetError();
      result.push({
        name: `loop_tool_${result.length}`,
        connectionId: row.id,
        tool: tool.name,
        description: `${row.name}: ${String(tool.description || tool.name).slice(0, 1500)}`,
        inputSchema: tool.inputSchema,
      });
    }
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MCP_TOOL_BUDGET.bytes)
    throw new ToolBudgetError();
  return result;
}
