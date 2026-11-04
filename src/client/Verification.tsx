import { useEffect, useState } from "react";
import { Sheet } from "./components";
import { type VerificationItem } from "../shared/verification";

type Detail = VerificationItem & { output_tail: string | null };
const when = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const statusLabel = {
  passed: "Passed",
  failed: "Failed",
  unknown: "Exit not reported",
} as const;

export function VerificationSheet({
  runId,
  load,
  onClose,
}: {
  runId: string;
  load: (runId: string) => Promise<Detail[]>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Detail[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    load(runId)
      .then((result) => live && setItems(result))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [runId]);
  return (
    <Sheet
      title="Verification"
      wide
      onClose={onClose}
      className="changes-sheet"
    >
      {error && <p className="field-error">{error}</p>}
      {!items && !error && <p role="status">Loading…</p>}
      {items && (
        <>
          <p className="changes-meta">
            Commands the agent ran and the exit Loop saw. The agent chose them:
            a passing check shows that command passed, not that the right tests
            exist.
          </p>
          {!items.length && (
            <p className="field-hint">
              No test, type-check or lint command was observed.
            </p>
          )}
          {items.map((item) => (
            <details
              key={item.id}
              className="pull-file verification-item"
              open={items.length <= 3}
            >
              <summary>
                <span
                  className={`pull-file-status verification-${item.status}`}
                >
                  {item.status === "unknown" && item.exit_code !== null
                    ? `Chain exited ${item.exit_code}; which step failed is not known`
                    : statusLabel[item.status]}
                  {item.status === "failed" && item.exit_code !== null
                    ? ` (exit ${item.exit_code})`
                    : ""}
                </span>
                <span className="pull-file-path">
                  <code>{item.command}</code>
                </span>
              </summary>
              <p className="field-hint">
                {item.kind} · {item.tools.join(" + ")} ·{" "}
                {when(item.observed_at)}
                {item.truncated ? " · output cut short" : ""}
              </p>
              {item.output_tail ? (
                <pre className="verification-output">{item.output_tail}</pre>
              ) : (
                <p className="field-hint">No output was kept.</p>
              )}
            </details>
          ))}
        </>
      )}
    </Sheet>
  );
}
