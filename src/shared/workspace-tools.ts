export const WORKSPACE_MCP_SERVER = "loop_workspace";
export const PUBLISH_FILE_TOOL = "loop_publish_file";

export function isWorkspaceMemorySearch(name: unknown) {
  return (
    name === "loop_memory_search" ||
    name === `mcp__${WORKSPACE_MCP_SERVER}__loop_memory_search` ||
    name === `${WORKSPACE_MCP_SERVER}_loop_memory_search`
  );
}

export type WorkspaceTools = { url: string; token: string };
