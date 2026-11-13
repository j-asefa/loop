import { AgentId, McpConnectionId } from "./contract-ids.js";
import { z } from "zod";

export const toolInvocationSchema = z.object({
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()),
});
const refreshSourceSchema = toolInvocationSchema.extend({
  agentId: AgentId.min(1),
  connectionId: McpConnectionId.min(1),
});
/** Stored refresh context, not a grant: the action rechecks owner/tool access. */
export function artifactRefreshSource(
  agentId: unknown,
  metadata: Record<string, unknown>,
) {
  const result = refreshSourceSchema.safeParse({ ...metadata, agentId });
  return result.success ? result.data : null;
}
