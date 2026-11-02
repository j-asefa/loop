import * as approvalsQueries from "./sql/approvals.js";
import * as nativeDispatchQueries from "./sql/native-dispatch.js";
import * as runsQueries from "./sql/runs.js";
import { ApprovalRecord } from "./row-schemas.js";

import { createHash } from "node:crypto";
import { db, id, now, emit } from "./db.js";
import { ownedApproval, ownedRun, ownedRunControl, Problem } from "./domain.js";
import { transition, type Run } from "./queue.js";
import { recordPersonalDecision } from "./personal-decisions.js";
import {
  assertFleetEffect,
  recordFleetEffectEdit,
} from "./fleet-effect-authorizations.js";
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
  automatic = false,
) {
  return db
    .transaction(() => {
      const approval = ownedApproval(approvalId, owner);
      const run =
        decision === "reject"
          ? ownedRunControl(approval.run_id, owner)
          : ownedRun(approval.run_id, owner);
      if (approval.state !== "pending" || run.state !== "awaiting_approval")
        throw new Problem(409, "This approval is no longer pending");
      if (approval.expires_at < now())
        throw new Problem(
          409,
          "This approval expired. Start a new run after review.",
        );
      const resumesNative = nativeDispatchQueries.hasAcceptedOrUnknown(
        db,
        run.id,
      );
      if (decision === "approve" || resumesNative) {
        assertFleetEffect(owner, "run", run.id);
        recordFleetEffectEdit(owner, "run", run.id);
      }
      approvalsQueries.decide(
        db,
        decision === "approve" ? "approved" : "rejected",
        approvalId,
        "pending",
      );
      if (!automatic)
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
          origin: "loop55",
        });
      } else if (decision === "approve")
        transition(run, "queued", { approvalId });
      else {
        runsQueries.setError(db, "Approval was rejected.", run.id);
        transition(run, "failed", { approvalId, reason: "Approval rejected" });
      }
      return { ok: true };
    })
    .immediate();
}
