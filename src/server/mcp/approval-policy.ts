import * as mcpPreferencesQueries from "../sql/mcp-preferences.js";
import * as approvalsQueries from "../sql/approvals.js";
import { db, now } from "../db.js";
import { approve } from "../approvals.js";
import { Problem } from "../domain.js";
import { MAX_CONCURRENT_RUNS } from "../../shared/concurrency.js";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
} from "../../shared/permission-modes.js";

export function mcpApprovalMode(owner: string): "ask" | "allow" {
  return mcpPreferencesQueries.approvalMode(db, owner)?.approval_mode || "ask";
}
/** Whether agent-created pull requests automatically start polling watches. */
export function autoWatchPrs(owner: string): boolean {
  return mcpPreferencesQueries.autoWatchPrs(db, owner)?.auto_watch_prs === 1;
}
export function setAutoWatchPrs(owner: string, enabled: boolean) {
  mcpPreferencesQueries.setAutoWatchPrs(db, owner, enabled ? 1 : 0);
  return { autoWatchPrs: enabled };
}
/** Optional per-harness active-run cap for this owner (null means workspace limit). */
export function maxConcurrentPerHarness(owner: string): number | null {
  const value = mcpPreferencesQueries.maxConcurrentPerHarness(
    db,
    owner,
  )?.max_concurrent_per_harness;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CONCURRENT_RUNS
  )
    return value;
  return null;
}
export function setMaxConcurrentPerHarness(
  owner: string,
  limit: number | null,
) {
  mcpPreferencesQueries.setMaxConcurrentPerHarness(db, owner, limit);
  return { maxConcurrentPerHarness: limit };
}
/** The workspace's standing approval level for native harness tool calls. */
export function agentPermissionMode(owner: string): PermissionMode {
  const mode = mcpPreferencesQueries.agentPermissionMode(
    db,
    owner,
  )?.agent_permission_mode;
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
        // Only existing calls on connected MCPs are covered. Installation
        // approvals still require their own explicit decision.
        const pending = approvalsQueries.pendingMcpCalls(db, owner, now());
        for (const approval of pending) {
          let alwaysAsk = true;
          try {
            const tool = JSON.parse(approval.tools).find(
              (item: any) => item.name === approval.tool,
            );
            alwaysAsk =
              !tool ||
              (tool._meta?.loop ?? tool._meta?.loop)?.alwaysAsk === true;
          } catch {
            // An unreadable catalog cannot authorize a queued effect.
          }
          if (alwaysAsk) continue;
          try {
            approve(owner, approval.id, { by: "policy" });
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
