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
    (
      db
        .prepare("SELECT approval_mode FROM mcp_preferences WHERE owner_id=?")
        .get(owner) as any
    )?.approval_mode || "ask"
  );
}
/** The workspace's standing approval level for native harness tool calls. */
export function agentPermissionMode(owner: string): PermissionMode {
  const mode = (
    db
      .prepare(
        "SELECT agent_permission_mode FROM mcp_preferences WHERE owner_id=?",
      )
      .get(owner) as any
  )?.agent_permission_mode;
  return isPermissionMode(mode) ? mode : DEFAULT_PERMISSION_MODE;
}
// New native sessions start in the chosen mode; a running session switches
// at its next turn. Decisions already waiting keep asking.
export function setAgentPermissionMode(owner: string, mode: PermissionMode) {
  db.prepare(
    "INSERT INTO mcp_preferences(owner_id,approval_mode,agent_permission_mode) VALUES(?,'ask',?) ON CONFLICT(owner_id) DO UPDATE SET agent_permission_mode=excluded.agent_permission_mode",
  ).run(owner, mode);
  return { agentPermissionMode: mode };
}
export function setMcpApprovalMode(owner: string, mode: "ask" | "allow") {
  return db
    .transaction(() => {
      db.prepare(
        "INSERT INTO mcp_preferences(owner_id,approval_mode) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET approval_mode=excluded.approval_mode",
      ).run(owner, mode);
      let resumed = 0;
      if (mode === "allow") {
        // Only existing calls on connected MCPs are covered. Installation and
        // workflow review approvals still require their own explicit decision.
        const pending = db
          .prepare(
            `SELECT a.id,a.run_id,c.tools,json_extract(a.request,'$.tool') AS tool FROM approvals a
        JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
        JOIN mcp_connections c ON c.id=json_extract(a.request,'$.connectionId') AND c.owner_id=a.owner_id
        WHERE a.owner_id=? AND a.state='pending' AND a.expires_at>?
          AND r.state='awaiting_approval' AND c.status='connected'
          AND json_extract(a.request,'$.type')='mcp_tool'`,
          )
          .all(owner, now()) as {
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
            alwaysAsk = !tool || tool._meta?.loop?.alwaysAsk === true;
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
