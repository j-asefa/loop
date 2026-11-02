import * as mcpPreferencesQueries from "../sql/mcp-preferences.js";
import * as approvalsQueries from "../sql/approvals.js";
import { db, emit, now } from "../db.js";
import { decide } from "../approvals.js";
import { Problem } from "../domain.js";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
} from "../../shared/permission-modes.js";

export function mcpApprovalMode(owner: string): "ask" | "allow" {
  return (
    (mcpPreferencesQueries.approvalMode(db, owner) as any)?.approval_mode ||
    "ask"
  );
}
/** The workspace's standing approval level for native harness tool calls. */
export function agentPermissionMode(owner: string): PermissionMode {
  const mode = (mcpPreferencesQueries.agentPermissionMode(db, owner) as any)
    ?.agent_permission_mode;
  return isPermissionMode(mode) ? mode : DEFAULT_PERMISSION_MODE;
}
// New native sessions start in the chosen mode; a running session switches
// at its next turn. Decisions already waiting keep asking.
export function setAgentPermissionMode(owner: string, mode: PermissionMode) {
  mcpPreferencesQueries.setAgentPermissionMode(db, owner, mode);
  return { agentPermissionMode: mode };
}
export function setMcpApprovalMode(owner: string, mode: "ask" | "allow") {
  return db
    .transaction(() => {
      mcpPreferencesQueries.setApprovalMode(db, owner, mode);
      let resumed = 0;
      if (mode === "allow") {
        // Only existing calls on connected MCPs are covered. Installation and
        // workflow review approvals still require their own explicit decision.
        const pending = approvalsQueries.pendingMcpCalls(db, owner, now()) as {
          id: string;
          run_id: string;
          tools: string;
          tool: string;
        }[];
        for (const approval of pending) {
          let alwaysAsk = true;
          try {
            const tool = JSON.parse(approval.tools).find(
              (item: any) => item.name === approval.tool,
            );
            alwaysAsk =
              !tool ||
              (tool._meta?.loop55 ?? tool._meta?.loop)?.alwaysAsk === true;
          } catch {
            // An unreadable catalog cannot authorize a queued effect.
          }
          if (alwaysAsk) continue;
          try {
            decide(owner, approval.id, "approve", true);
            emit(owner, approval.run_id, "approval.auto_approved", {
              approvalId: approval.id,
            });
            resumed++;
          } catch (error) {
            if (!(error instanceof Problem && error.status === 409))
              throw error;
          }
        }
      }
      return { approvalMode: mode, resumed };
    })
    .immediate();
}
