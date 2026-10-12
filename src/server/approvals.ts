import { createHash } from "node:crypto";
import { db, id, now, emit } from "./db.js";
import { owned, Problem } from "./domain.js";
import { transition, type Run } from "./queue.js";
export function requestApproval(
  run: Run,
  request: unknown,
  autoApproved = false,
) {
  const encoded = JSON.stringify(request),
    digest = createHash("sha256").update(encoded).digest("hex");
  const prior = db
    .prepare(
      "SELECT * FROM approvals WHERE owner_id=? AND run_id=? AND digest=?",
    )
    .get(run.owner_id, run.id, digest) as any;
  if (prior) return prior;
  const approvalId = id();
  db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,?,NULL,?,?)").run(
    approvalId,
    run.owner_id,
    run.id,
    digest,
    encoded,
    autoApproved ? "approved" : "pending",
    now(),
    now() + 24 * 60 * 60 * 1000,
  );
  emit(
    run.owner_id,
    run.id,
    autoApproved ? "approval.auto_approved" : "approval.requested",
    { approvalId, request },
  );
  return owned<any>("approvals", approvalId, run.owner_id);
}
export function decide(
  owner: string,
  approvalId: string,
  decision: "approve" | "reject",
) {
  return db
    .transaction(() => {
      const approval = owned<any>("approvals", approvalId, owner);
      const run = owned<Run>("runs", approval.run_id, owner);
      if (approval.state !== "pending" || run.state !== "awaiting_approval")
        throw new Problem(409, "This approval is no longer pending");
      if (approval.expires_at < now())
        throw new Problem(
          409,
          "This approval expired. Start a new run after review.",
        );
      db.prepare("UPDATE approvals SET state=? WHERE id=? AND state=?").run(
        decision === "approve" ? "approved" : "rejected",
        approvalId,
        "pending",
      );
      if (
        db
          .prepare(
            "SELECT 1 FROM native_dispatch WHERE run_id=? AND state IN ('accepted','unknown')",
          )
          .get(run.id)
      ) {
        db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
        emit(owner, run.id, "approval.decided", {
          approvalId,
          decision,
          origin: "loop",
        });
      } else if (decision === "approve")
        transition(run, "queued", { approvalId });
      else {
        db.prepare("UPDATE runs SET error=? WHERE id=?").run(
          "Approval was rejected.",
          run.id,
        );
        transition(run, "failed", { approvalId, reason: "Approval rejected" });
      }
      return { ok: true };
    })
    .immediate();
}
