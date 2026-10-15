import type { CheckoutSummary } from "./checkout.js";
import type { VerificationSummary } from "./verification.js";
import type { PullState } from "./pull-state.js";

export type ProjectStatusAction = {
  key: string;
  kind: "approve" | "answer" | "resume" | "failed" | "not_sent" | "review";
  conversation: string | null;
  message: string | null;
  ref: string;
  at: number;
};
export type ProjectStatus = {
  id: string;
  name: string;
  status: "needs_you" | "blocked" | "working" | "queued" | "idle";
  last_activity_at: number;
  older: boolean;
  counts: { needs: number; working: number; queued: number };
  actions: ProjectStatusAction[];
  brief: {
    state: "never" | "pending" | "failed" | "off" | "ready";
    headline: string | null;
    synthesized_at: number | null;
    pending: number;
    unfinished: number | null;
    questions: number | null;
    /** Known recorded blockers; null means no record, not zero blockers. */
    blockers: number | null;
  };
  evidence: {
    run_id: string;
    conversation: string;
    agent: string;
    task: string;
    checkout: CheckoutSummary | null;
    checkout_at: number | null;
    verification: VerificationSummary | null;
    verification_at: number | null;
    telemetry: "observed" | "unavailable";
  } | null;
  /** Watch observations are project scoped, never inferred to belong to the run. */
  pulls: { id: string; conversation: string; state: PullState }[];
};
export type ProjectStatusPage = {
  owner_id: string;
  observed_at: number;
  /** Activity and evidence follow teams; the brief always describes the project. */
  teams: string[] | null;
  items: ProjectStatus[];
};
export const projectStatusOrder: Record<ProjectStatus["status"], number> = {
  needs_you: 0,
  blocked: 1,
  working: 2,
  queued: 3,
  idle: 4,
};
export function compareProjectStatus(a: ProjectStatus, b: ProjectStatus) {
  return (
    projectStatusOrder[a.status] - projectStatusOrder[b.status] ||
    b.last_activity_at - a.last_activity_at ||
    a.id.localeCompare(b.id)
  );
}
