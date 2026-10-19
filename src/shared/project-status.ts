import type { CheckoutSummary } from "./checkout.js";
import type { VerificationSummary } from "./verification.js";
import type { PullState } from "./pull-state.js";
import type { PullRequestRef } from "./github.js";
import type { BriefGenerationUsage } from "./brief-usage.js";
import type { ItemSummary } from "../server/briefs/schema.js";
import type { DeploymentObservation } from "./build.js";

export type ProjectStatusAction = {
  key: string;
  conversation: string | null;
  message: string | null;
  ref: string;
  at: number;
  title?: string;
} & (
  | { kind: "approve" | "answer" | "resume" | "failed" | "not_sent" }
  | { kind: "review"; pull: PullRequestRef }
);
export type ProjectStatus = {
  id: string;
  name: string;
  deployments?: DeploymentObservation[];
  status: "needs_you" | "blocked" | "working" | "queued" | "idle";
  last_activity_at: number;
  older: boolean;
  counts: { needs: number; working: number; queued: number };
  actions: ProjectStatusAction[];
  brief: {
    generation_usage?: BriefGenerationUsage | null;
    state: "never" | "pending" | "failed" | "off" | "ready";
    headline: string | null;
    update?: string | null;
    /** Pins headline evidence to the version displayed on the card. */
    version?: number | null;
    /** Optional for cached responses and workspaces running an older version. */
    highlights?: {
      updated_at: number;
      progress: { id: string; text: string; summary?: ItemSummary }[];
      task: {
        id: string;
        text: string;
        summary?: ItemSummary;
        next: string | null;
        blocker: string | null;
      } | null;
      question: { id: string; text: string; summary?: ItemSummary } | null;
    };
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
  /** Display names from this workspace only; optional for older responses. */
  agents?: { id: string; name: string }[];
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
