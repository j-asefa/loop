import { agentStatusLine } from "../../../src/shared/agent-status-line";
import type { ApiAgent } from "./api/types";

export function agentProfileTagline(
  agent: Pick<ApiAgent, "id" | "instructions">,
  hasPendingWork: boolean,
) {
  if (hasPendingWork || agent.instructions?.trim()) return null;
  return agentStatusLine(agent.id);
}
