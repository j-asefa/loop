import * as approvalsQueries from "./sql/approvals.js";
import * as nativeDispatchQueries from "./sql/native-dispatch.js";
import * as runsQueries from "./sql/runs.js";
import { ApprovalRecord } from "./row-schemas.js";

import { createHash } from "node:crypto";
import { db, id, now, emit } from "./db.js";
import { ownedApproval, ownedRun, ownedRunControl, Problem } from "./domain.js";
import { transition, type Run } from "./queue.js";
import { recordPersonalDecision } from "./personal-decisions.js";
import { assertEffect, recordEffectEdit } from "./effect-authority.js";
export function requestApproval(
  run: Run,
  request: unknown,
  autoApproved = false,
) {
  const encoded = JSON.stringify(request),
    digest = createHash("sha256").update(encoded).digest("hex");
  const prior = approvalsQueries.byDigest(db, run.owner_id, run.id, digest);
  if (prior) return ApprovalRecord.parse(prior);
  const approvalId = id();
  const createdAt = now();
  db.transaction(() => {
    approvalsQueries.insert(
      db,
      approvalId,
      run.owner_id,
      run.id,
      digest,
      encoded,
      autoApproved ? "approved" : "pending",
      createdAt,
      now() + 24 * 60 * 60 * 1000,
    );
  }).immediate();
  emit(
    run.owner_id,
    run.id,
    autoApproved ? "approval.auto_approved" : "approval.requested",
    { approvalId, request },
  );
  return ownedApproval(approvalId, run.owner_id);
}
export function decide(
  owner: string,
  approvalId: string,
  decision: "approve" | "reject",
) {
  return decision === "approve"
    ? approve(owner, approvalId, { by: "user" })
    : decideApproval(owner, approvalId, decision, { by: "user" });
}
type ApprovalSource =
  { by: "user" } | { by: "policy"; execution?: "resume" | "inline" };
export function approve(
  owner: string,
  approvalId: string,
  source: ApprovalSource,
) {
  return decideApproval(owner, approvalId, "approve", source);
}
function decideApproval(
  owner: string,
  approvalId: string,
  decision: "approve" | "reject",
  source: ApprovalSource,
) {
  return db
    .transaction(() => {
      const approval = ownedApproval(approvalId, owner);
      const run =
        decision === "reject"
          ? ownedRunControl(approval.run_id, owner)
          : ownedRun(approval.run_id, owner);
      const inline = source.by === "policy" && source.execution === "inline";
      const time = now();
      // An inline call is already executing, including when pausing. It must
      // not requeue the run or record a new dispatch source.
      if (
        inline &&
        (approval.state !== "pending" || approval.expires_at <= time)
      )
        return { ok: false };
      if (
        approval.state !== "pending" ||
        (!inline && run.state !== "awaiting_approval")
      )
        throw new Problem(409, "This approval is no longer pending");
      if (approval.expires_at < time)
        throw new Problem(
          409,
          "This approval expired. Start a new run after review.",
        );
      const resumesNative =
        !inline && nativeDispatchQueries.hasAcceptedOrUnknown(db, run.id);
      if (!inline && (decision === "approve" || resumesNative)) {
        assertEffect(owner, "run", run.id);
        recordEffectEdit(owner, "run", run.id);
      }
      approvalsQueries.decide(
        db,
        decision === "approve" ? "approved" : "rejected",
        approvalId,
        "pending",
      );
      if (source.by === "user")
        recordPersonalDecision({
          owner,
          run: run.id,
          approval: approvalId,
          answer: { choice: decision },
        });
      if (resumesNative) {
        runsQueries.resumeAfterApproval(db, run.id);
        emit(owner, run.id, "approval.decided", {
          approvalId,
          decision,
          origin: "loop",
        });
      } else if (!inline && decision === "approve")
        transition(run, "queued", { approvalId });
      else if (decision === "reject") {
        runsQueries.setError(db, "Approval was rejected.", run.id);
        transition(run, "failed", { approvalId, reason: "Approval rejected" });
      }
      if (source.by === "policy")
        emit(owner, run.id, "approval.auto_approved", { approvalId });
      return { ok: true };
    })
    .immediate();
}
