/**
 * A thread's pull request as its watch last observed it: which head GitHub
 * reported, what the checks concluded for which head, and when Loop last
 * looked. A card shows this as one line. It is what the watch read, as
 * fresh as its last poll; Loop never claims more than that.
 */
export type PullState = {
  repo_owner: string;
  repo_name: string;
  number: number;
  /** watching: polled about once a minute; paused: needs Resume; stopped: merged, closed or stopped. */
  watch: "watching" | "paused" | "stopped";
  ended_reason: string | null;
  /** The watch's last error, when paused or failing to read. */
  error: string | null;
  /** The head the watch last saw on GitHub. */
  head_sha: string | null;
  /** The last concluded checks: for which head, and how. */
  ci: { sha: string; conclusion: "success" | "failure" } | null;
  /** Checks for the current head had not all finished at the last read. */
  pending: boolean;
  /** When the watch last read GitHub successfully; null before its first read. */
  checked_at: number | null;
};

export type WatchRow = {
  repo_owner: string;
  repo_name: string;
  number: number;
  state: "watching" | "paused" | "stopped";
  ended_reason: string | null;
  error: string | null;
  head_sha: string | null;
  ci_sha: string | null;
  ci_conclusion: string | null;
  ci_pending: number;
  read_at: number | null;
  /** The result the last read saw, which may still be waiting for delivery. */
  seen_ci_sha: string | null;
  seen_ci_conclusion: string | null;
};

export function pullStateFromWatch(watch: WatchRow): PullState {
  // The card shows what the watch last saw, delivered to the thread or not.
  const sha = watch.seen_ci_sha ?? watch.ci_sha;
  const raw = watch.seen_ci_sha
    ? watch.seen_ci_conclusion
    : watch.ci_conclusion;
  const conclusion =
    raw === "success" || raw === "failure"
      ? (raw as "success" | "failure")
      : null;
  const concluded = sha && conclusion ? { sha, conclusion } : null;
  return {
    repo_owner: watch.repo_owner,
    repo_name: watch.repo_name,
    number: watch.number,
    watch: watch.state,
    ended_reason: watch.ended_reason,
    error: watch.error,
    head_sha: watch.head_sha,
    ci: concluded,
    pending: !!watch.ci_pending,
    checked_at: watch.read_at,
  };
}
