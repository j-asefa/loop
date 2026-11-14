import type { WorkspaceToolHarness } from "../shared/harnesses.js";
import {
  WORKSPACE_MCP_SERVER,
  type WorkspaceTools,
} from "../shared/workspace-tools.js";

/** Native protocol encodings of the same generation-scoped workspace bridge. */
export function workspaceMcp({ url, token }: WorkspaceTools) {
  const headers = { Authorization: `Bearer ${token}` };
  const acp = [
    {
      type: "http" as const,
      name: "loop-workspace",
      url,
      headers: [{ name: "Authorization", value: headers.Authorization }],
    },
  ];
  return {
    claude: {
      mcpServers: { [WORKSPACE_MCP_SERVER]: { type: "http", url, headers } },
    },
    codex: {
      [`mcp_servers.${WORKSPACE_MCP_SERVER}`]: { url, http_headers: headers },
    },
    muse: {
      mcpServers: {
        [WORKSPACE_MCP_SERVER]: {
          transport: "streamableHttp",
          // A workspace-tools outage must not fail the Muse turn.
          mode: "optional",
          url,
          headers,
        },
      },
    },
    opencode: { [WORKSPACE_MCP_SERVER]: { type: "remote", url, headers } },
    acp,
    grok: acp,
    pi: { LOOP_TOOLS_URL: url, LOOP_TOOLS_TOKEN: token },
  } satisfies Record<WorkspaceToolHarness, unknown>;
}
