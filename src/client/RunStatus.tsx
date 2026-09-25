export function RunStatus({
  state,
  error,
  empty = false,
}: {
  state?: string | null;
  error?: string | null;
  empty?: boolean;
}) {
  if (!state || (state === "completed" && !empty)) return null;
  const labels: Record<string, string> = {
    queued: "Queued",
    running: "Working…",
    pausing: "Pausing…",
    paused: "Paused",
    awaiting_approval: "Waiting for your approval",
    waiting_children: "Waiting for teammates",
    failed: "Run failed",
    interrupted: "Run interrupted",
    cancelled: "Cancelled",
    completed: "Completed without a text response",
  };
  const stopped = ["failed", "interrupted", "cancelled", "completed"].includes(
    state,
  );
  return (
    <div
      className={
        "response-status" +
        (["failed", "interrupted"].includes(state) ? " needs-attention" : "")
      }
      role="status"
    >
      <strong>{labels[state] || state}</strong>
      {error && <span>{error}</span>}
      {empty && stopped && <span>No answer was saved for this run.</span>}
      {state === "interrupted" && !error && (
        <span>
          The worker stopped before finishing. Review any partial work before
          retrying.
        </span>
      )}
      {state === "awaiting_approval" && (
        <span>Review the tool request in Running → Needs you.</span>
      )}
    </div>
  );
}
