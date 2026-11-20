export const WORKSPACE_MCP_SERVER = "loop_workspace";

/** Native MCP identities use the mcp__server__tool form. */
export function isExternalMcpTool(name: unknown): boolean {
  return (
    typeof name === "string" &&
    /^mcp__.+__.+$/.test(name) &&
    !name.startsWith(`mcp__${WORKSPACE_MCP_SERVER}__`) &&
    !name.startsWith("mcp____loop____")
  );
}
export const PUBLISH_FILE_TOOL = "loop_publish_file";

export function isWorkspaceMemorySearch(name: unknown) {
  return (
    name === "loop_memory_search" ||
    name === `mcp__${WORKSPACE_MCP_SERVER}__loop_memory_search` ||
    name === `${WORKSPACE_MCP_SERVER}_loop_memory_search`
  );
}

export type WorkspaceTools = { url: string; token: string };
