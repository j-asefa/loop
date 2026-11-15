import type { PullRequestState } from "../shared/github";
import type { ChecksState, ReviewDecision } from "../shared/pull-requests";

export const PULL_STATE_LABEL: Record<PullRequestState, string> = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export const PULL_CHECKS_LABEL: Record<ChecksState, string> = {
  success: "Checks passed",
  failure: "Checks failed",
  pending: "Checks running",
};

export const PULL_REVIEW_LABEL: Record<ReviewDecision, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
};
