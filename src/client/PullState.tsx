import { GitPullRequest } from "lucide-react";
import { pullStateLine, type PullState } from "../shared/pull-state";

/**
 * The thread's pull request as its watch last saw it: which checks concluded
 * for which head, and when Loop last looked. Tapping opens the pull request
 * in the Pull requests tab. "No PR linked" shows for a run that produced a
 * checkout but no watched pull request.
 */
export function PullStateChip({
  state,
  onOpen,
  compact = false,
}: {
  state: PullState | null;
  onOpen?: () => void;
  /** PR number and any recorded CI result, without hashes or empty badges. */
  compact?: boolean;
}) {
  if (compact && !state) return null;
  const line = pullStateLine(state);
  const current =
    state?.ci &&
    state.ci.sha === state.head_sha &&
    state.checked_at !== null &&
    !state.pending;
  const detailLabel =
    compact && state?.ci
      ? [
          !state.head_sha || state.checked_at === null
            ? "CI freshness unknown"
            : state.ci.sha !== state.head_sha
              ? "CI outdated"
              : state.pending
                ? "CI rerunning"
                : state.ci.conclusion === "success"
                  ? "CI passed"
                  : "CI failed",
          state.watch === "stopped"
            ? ["merged", "closed"].includes(state.ended_reason ?? "")
              ? state.ended_reason
              : "watch stopped"
            : state.watch === "paused"
              ? "paused"
              : state.error
                ? "refresh failed"
                : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : line;
  const description = compact && state?.ci ? `${detailLabel} · ${line}` : line;
  const compactStatus = state
    ? state.watch === "stopped"
      ? state.ended_reason === "merged"
        ? "merged"
        : state.ended_reason === "closed"
          ? "closed"
          : "stopped"
      : !state.ci
        ? ""
        : state.watch === "paused"
          ? "CI paused"
          : state.error
            ? "CI stale"
            : !state.head_sha || state.checked_at === null
              ? "CI unknown"
              : state.ci.sha !== state.head_sha
                ? "CI stale"
                : state.pending
                  ? "CI rerun"
                  : state.ci.conclusion === "success"
                    ? "CI passed"
                    : "CI failed"
    : "";
  const label =
    compact && state
      ? [`#${state.number}`, compactStatus].filter(Boolean).join(" · ")
      : line;
  const tone = !state
    ? "none"
    : state.watch === "stopped"
      ? "stopped"
      : current && !(compact && (state.error || state.watch === "paused"))
        ? state.ci?.conclusion === "success"
          ? "passed"
          : "failed"
        : "pending";
  if (!state || !onOpen)
    return (
      <span
        className={`changes-chip pull-state-chip pull-state-${tone}`}
        aria-label={description}
        title={compact ? description : undefined}
      >
        <GitPullRequest size={16} aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  return (
    <button
      type="button"
      className={`changes-chip pull-state-chip pull-state-${tone}`}
      onClick={onOpen}
      aria-label={`Pull request: ${description}`}
      title={compact ? description : undefined}
    >
      <GitPullRequest size={16} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
