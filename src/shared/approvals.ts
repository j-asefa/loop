import { z } from "zod";

// The approval decision an owner or integration can give: one definition shared
// by the decision route body and the event payload (D1).
export const ApprovalDecision = z.enum(["approve", "reject"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

// The approval lifecycle (docs/state-machines.md, approvals.state) (D1).
export const ApprovalStates = [
  "pending",
  "approved",
  "executing",
  "rejected",
  "completed",
  "unknown",
] as const;
export const ApprovalState = z.enum(ApprovalStates);
export type ApprovalState = z.infer<typeof ApprovalState>;
