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
  /** Absent from an older linked server: freshness is then unknown. */
  ci_pending?: number;
  read_at?: number | null;
  /** The result the last read saw, which may still be waiting for delivery. */
  seen_ci_sha?: string | null;
  seen_ci_conclusion?: string | null;
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
    // Without the freshness fields (an older linked server), a conclusion
    // is never shown as current.
    pending: watch.ci_pending === undefined ? true : !!watch.ci_pending,
    checked_at: watch.read_at === undefined ? null : watch.read_at,
  };
}

const short = (sha: string) => sha.slice(0, 7);
function ago(at: number, at_now: number) {
  const s = Math.max(0, Math.round((at_now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * The card line. Checks are reported for the head they concluded on: a
 * conclusion for an older head is stale, not current, and says so.
 */
export function pullStateLine(state: PullState | null, at_now = Date.now()) {
  if (!state) return "No PR linked";
  const parts = [`PR #${state.number}`];
  if (state.watch === "stopped") {
    parts.push(state.ended_reason ? state.ended_reason : "no longer watched");
    return parts.join(" · ");
  }
  const verdict = (c: { conclusion: "success" | "failure" }) =>
    c.conclusion === "success" ? "passed" : "failed";
  if (!state.head_sha) parts.push("not read yet");
  else if (state.checked_at === null)
    parts.push(
      state.ci
        ? `last ${verdict(state.ci)} for ${short(state.ci.sha)}, freshness unknown`
        : "checks state unknown",
    );
  else if (state.ci && state.ci.sha === state.head_sha && !state.pending)
    parts.push(`checks ${verdict(state.ci)} for ${short(state.head_sha)}`);
  else if (state.ci && state.ci.sha === state.head_sha)
    parts.push(
      `checks rerunning for ${short(state.head_sha)} (last ${verdict(state.ci)})`,
    );
  else if (state.ci)
    parts.push(
      `checks pending for ${short(state.head_sha)} (last ${verdict(state.ci)} for ${short(state.ci.sha)})`,
    );
  else parts.push(`checks pending for ${short(state.head_sha)}`);
  if (state.watch === "paused") parts.push("watch paused");
  else if (state.error) parts.push("last read failed");
  if (state.checked_at !== null)
    parts.push(`checked ${ago(state.checked_at, at_now)}`);
  return parts.join(" · ");
}
