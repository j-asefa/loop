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
  /** When the watch last read GitHub successfully. */
  checked_at: number;
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
  updated_at: number;
};

export function pullStateFromWatch(watch: WatchRow): PullState {
  const conclusion =
    watch.ci_conclusion === "success" || watch.ci_conclusion === "failure"
      ? (watch.ci_conclusion as "success" | "failure")
      : null;
  const concluded = watch.ci_sha && conclusion ? { sha: watch.ci_sha, conclusion } : null;
  return {
    repo_owner: watch.repo_owner,
    repo_name: watch.repo_name,
    number: watch.number,
    watch: watch.state,
    ended_reason: watch.ended_reason,
    error: watch.error,
    head_sha: watch.head_sha,
    ci: concluded,
    checked_at: watch.updated_at,
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
  if (!state.head_sha) parts.push("not read yet");
  else if (state.ci && state.ci.sha === state.head_sha)
    parts.push(`checks ${state.ci.conclusion === "success" ? "passed" : "failed"} for ${short(state.head_sha)}`);
  else if (state.ci)
    parts.push(`checks pending for ${short(state.head_sha)} (last ${state.ci.conclusion === "success" ? "passed" : "failed"} for ${short(state.ci.sha)})`);
  else parts.push(`checks pending for ${short(state.head_sha)}`);
  if (state.watch === "paused") parts.push("watch paused");
  else if (state.error) parts.push("last read failed");
  parts.push(`checked ${ago(state.checked_at, at_now)}`);
  return parts.join(" · ");
}
