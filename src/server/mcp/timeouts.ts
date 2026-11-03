// Browser navigation and repository tools can take longer than a model request.
// Operators can tune this without rebuilding; failed calls are never replayed.
const configured = Number(process.env.LOOP_MCP_TOOL_TIMEOUT_MS || 300000);
if (
  !Number.isSafeInteger(configured) ||
  configured <= 0 ||
  configured > 2147483647
)
  throw new Error(
    "LOOP_MCP_TOOL_TIMEOUT_MS must be a positive timer duration in milliseconds.",
  );
export const MCP_TOOL_TIMEOUT_MS = configured;
