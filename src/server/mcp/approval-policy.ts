import { db, emit, now } from "../db.js";
import { decide } from "../approvals.js";
import { Problem } from "../domain.js";
import { requiresExplicitApproval } from "../../shared/github.js";

export function mcpApprovalMode(owner: string): "ask" | "allow" {
  return (
    (
      db
        .prepare("SELECT approval_mode FROM mcp_preferences WHERE owner_id=?")
        .get(owner) as any
    )?.approval_mode || "ask"
  );
}
export function setMcpApprovalMode(owner: string, mode: "ask" | "allow") {
  return db
    .transaction(() => {
      db.prepare(
        "INSERT INTO mcp_preferences VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET approval_mode=excluded.approval_mode",
      ).run(owner, mode);
      let resumed = 0;
      if (mode === "allow") {
        // Only existing calls on connected MCPs are covered. Installation and
        // workflow review approvals still require their own explicit decision,
        // as do GitHub merges.
        const pending = db
          .prepare(
            `SELECT a.id,a.run_id,c.url,json_extract(a.request,'$.tool') AS tool FROM approvals a
        JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
        JOIN mcp_connections c ON c.id=json_extract(a.request,'$.connectionId') AND c.owner_id=a.owner_id
        WHERE a.owner_id=? AND a.state='pending' AND a.expires_at>?
          AND r.state='awaiting_approval' AND c.status='connected'
          AND json_extract(a.request,'$.type')='mcp_tool'`,
          )
          .all(owner, now()) as {
          id: string;
          run_id: string;
          url: string;
          tool: string;
        }[];
        for (const approval of pending) {
          if (requiresExplicitApproval(approval.url, approval.tool)) continue;
          try {
            decide(owner, approval.id, "approve");
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
