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
}: {
  state: PullState | null;
  onOpen?: () => void;
}) {
  const line = pullStateLine(state);
  const tone = !state
    ? "none"
    : state.watch === "stopped"
      ? "stopped"
      : state.ci && state.ci.sha === state.head_sha && !state.pending
        ? state.ci.conclusion === "success"
          ? "passed"
          : "failed"
        : "pending";
  if (!state || !onOpen)
    return (
      <span className={`changes-chip pull-state-chip pull-state-${tone}`} aria-label={line}>
        <GitPullRequest size={16} aria-hidden="true" />
        <span>{line}</span>
      </span>
    );
  return (
    <button
      type="button"
      className={`changes-chip pull-state-chip pull-state-${tone}`}
      onClick={onOpen}
      aria-label={`Pull request: ${line}`}
    >
      <GitPullRequest size={16} aria-hidden="true" />
      <span>{line}</span>
    </button>
  );
}
