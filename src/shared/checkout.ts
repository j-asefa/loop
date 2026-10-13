/** The one-line view of a run's checkout record; everything else is a tap away. */
export type CheckoutSummary = {
  id: string;
  state: "started" | "captured" | "failed";
  branch: string;
  base_ref: string | null;
  ahead: number | null;
  behind: number | null;
  files: number;
  additions: number;
  deletions: number;
  untracked: number;
  /** What the local remote-tracking ref said at capture; Loop never fetches. */
  remote: "none" | "contains" | "missing";
  started_dirty: boolean;
  overlap: number;
  /** Captured after a restart, later than the run ended. */
  late: boolean;
  error: string | null;
};

export type CheckoutFile = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
};
export type CheckoutStat = {
  files: CheckoutFile[];
  additions: number;
  deletions: number;
};
export type CheckoutRemote = {
  ref: string;
  sha: string;
  contains_head: boolean;
  observed_at: number;
};
export type CheckoutDetail = {
  id: string;
  run_id: string;
  agent_id: string;
  conversation_id: string;
  directory: string;
  source: string;
  branch: string;
  base_ref: string | null;
  base_sha: string | null;
  start_head: string;
  start_dirty: number;
  start_untracked: number;
  started_at: number;
  state: "started" | "captured" | "failed";
  end_head: string | null;
  ahead: number | null;
  behind: number | null;
  files: CheckoutFile[];
  committed: CheckoutStat | null;
  working: CheckoutStat | null;
  untracked: string[];
  patch: string | null;
  patch_bytes: number | null;
  patch_truncated: boolean;
  remote: CheckoutRemote | null;
  overlap: string[];
  captured_late: boolean;
  summary: CheckoutSummary | null;
  ended_at: number | null;
  error: string | null;
};

/** The card line. The same text is the brief's citable headline. */
export function checkoutLine(summary: CheckoutSummary) {
  const parts = [summary.branch];
  if (summary.ahead != null) {
    parts.push(
      summary.ahead === 1 ? "1 commit ahead" : `${summary.ahead} commits ahead`,
    );
    if (summary.behind) parts.push(`${summary.behind} behind`);
  }
  if (summary.state === "captured") {
    parts.push(
      summary.files
        ? `${summary.files} ${summary.files === 1 ? "file" : "files"} +${summary.additions} −${summary.deletions}`
        : "no changes",
    );
    if (summary.untracked) parts.push(`${summary.untracked} untracked`);
    parts.push(
      summary.remote === "contains"
        ? "on remote"
        : summary.remote === "missing"
          ? "not on remote"
          : "no remote seen",
    );
  } else if (summary.state === "failed") parts.push("checkout not captured");
  else parts.push("in progress");
  return parts.join(" · ");
}
