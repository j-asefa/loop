// The Pull requests screen: what the server reads from GitHub for you, without
// an agent. Titles, descriptions, comments and diffs are untrusted content
// from GitHub; they are shown to you and never passed to an agent from here.

import type { PullRequestRef, PullRequestState } from "./github";

export type PullFilter = "review" | "authored" | "involved";

export const PULL_FILTERS: { id: PullFilter; label: string }[] = [
  { id: "review", label: "Review requested" },
  { id: "authored", label: "Yours" },
  { id: "involved", label: "Involving you" },
];

/** The combined result of a pull request's checks on its head commit. */
export type ChecksState = "success" | "failure" | "pending";
export type ReviewDecision = "approved" | "changes_requested" | "review_required";

export type PullListItem = PullRequestRef & {
  title: string;
  url: string;
  state: PullRequestState;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  headRef?: string;
  baseRef?: string;
  additions?: number;
  deletions?: number;
  comments?: number;
  checks?: ChecksState;
  review?: ReviewDecision;
};

export type PullInbox =
  | { connected: false }
  | {
      connected: true;
      login: string;
      filter: PullFilter;
      repo?: string;
      counts: Record<PullFilter, number>;
      total: number;
      pulls: PullListItem[];
      fetchedAt: number;
    };

export type PullComment = {
  author?: string;
  body: string;
  createdAt?: string;
  url?: string;
  /** Whether the author has a role in the repository (owner, member, collaborator). */
  member: boolean;
};

export type PullCheck = {
  name: string;
  state: ChecksState | "neutral" | "skipped";
  url?: string;
  description?: string;
};

export type MergeMethod = "merge" | "squash" | "rebase";

export type PullDetail = PullListItem & {
  body: string;
  headSha: string;
  /** GitHub's merge state: clean, blocked, behind, dirty, draft, unstable… */
  mergeState?: string;
  conflicts: boolean;
  changedFiles?: number;
  commits?: number;
  requested: string[];
  reviews: (PullComment & { state: string })[];
  checkRuns: PullCheck[];
  threads: {
    id: string;
    path: string;
    line?: number;
    resolved: boolean;
    outdated: boolean;
    comments: PullComment[];
    /** All the thread's comments on GitHub; more than `comments` when shortened. */
    commentsTotal: number;
  }[];
  /** All review threads on GitHub; more than `threads` when some were left out. */
  threadsTotal: number;
  conversation: PullComment[];
  conversationTotal: number;
  viewer: {
    login: string;
    author: boolean;
    /** Repository write access: GitHub may still block a merge (rules, checks). */
    canMerge: boolean;
  };
  mergeMethods: MergeMethod[];
  fetchedAt: number;
};

export type PullFile = {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** The unified diff hunk text; missing when GitHub omits a large or binary diff. */
  patch?: string;
  truncated?: boolean;
};

export type PullFiles = {
  files: PullFile[];
  total?: number;
  /** The head commit these changes are for. */
  headSha: string;
  fetchedAt: number;
};

export const MAX_REVIEW_BODY = 20_000;
