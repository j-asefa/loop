import { useEffect, useRef, useState } from "react";
import "./agentActivities.css";

// Display-only components: paths and content never become links, HTML or commands.
// Their input comes from validated shared records, never extracted from prose.
export function PlanPanel({
  steps,
  explanation,
}: {
  steps: { id: string; text: string; status: string }[];
  explanation?: string | null;
}) {
  const completed = steps.filter((step) => step.status === "completed").length;
  return (
    <section className="activity-panel" aria-label="Plan">
      <h4>
        Plan{" "}
        <span className="activity-state">
          {completed} of {steps.length} complete
        </span>
      </h4>
      {explanation && <p>{explanation}</p>}
      <ol className="activity-plan">
        {steps.map((step) => (
          <li key={step.id} data-state={step.status}>
            <span aria-hidden="true">
              {step.status === "completed"
                ? "✓"
                : step.status === "in_progress"
                  ? "◉"
                  : "○"}
            </span>
            <span>{step.text}</span>
            <small>{step.status.replaceAll("_", " ")}</small>
          </li>
        ))}
      </ol>
      {!steps.length && <p className="note">The current plan has no steps.</p>}
    </section>
  );
}

const DISPLAY_LIMIT = 48_000;
export function FileChangePanel({
  path,
  oldPath,
  patch,
  before,
  after,
  state,
  reason,
  truncated,
  label = "File change",
  showPath = true,
}: {
  path: string;
  oldPath?: string | null;
  patch?: string | null;
  before?: string | null;
  after?: string | null;
  state: string;
  reason?: string | null;
  truncated?: boolean;
  /** Heading, e.g. "Edit 1 of 2" where a file heading already names the path. */
  label?: string;
  showPath?: boolean;
}) {
  const oversized = [patch, before, after].some(
    (value) => (value?.length || 0) > DISPLAY_LIMIT,
  );
  return (
    <details className="activity-panel activity-file" open>
      <summary>
        <strong>{label}</strong>
        <span className="activity-state">{state.replaceAll("_", " ")}</span>
        {showPath && <code>{oldPath ? `${oldPath} → ${path}` : path}</code>}
      </summary>
      {reason && <p className="note">{reason}</p>}
      {patch != null ? (
        <pre
          className="activity-scroll"
          tabIndex={0}
          aria-label={`Diff for ${path}`}
        >
          {patch
            .slice(0, DISPLAY_LIMIT)
            .split("\n")
            .map((line, index) => (
              <span
                key={index}
                className={
                  line.startsWith("@@") ||
                  line.startsWith("+++ ") ||
                  line.startsWith("--- ")
                    ? "diff-hunk"
                    : line.startsWith("+")
                      ? "diff-add"
                      : line.startsWith("-")
                        ? "diff-remove"
                        : "diff-context"
                }
              >
                {line}
                {"\n"}
              </span>
            ))}
        </pre>
      ) : before != null || after != null ? (
        <div className="activity-file-sides">
          <section>
            <h5>Before{before === null ? " (new file)" : ""}</h5>
            <pre className="activity-scroll" tabIndex={0}>
              {before === undefined
                ? "Not supplied"
                : (before || "").slice(0, DISPLAY_LIMIT)}
            </pre>
          </section>
          <section>
            <h5>After{after === null ? " (deleted file)" : ""}</h5>
            <pre className="activity-scroll" tabIndex={0}>
              {after === undefined
                ? "Not supplied"
                : (after || "").slice(0, DISPLAY_LIMIT)}
            </pre>
          </section>
        </div>
      ) : (
        !reason && <p className="note">Diff content was not supplied.</p>
      )}
      {(truncated || oversized) && (
        <p className="note">
          Diff display truncated. Full content is not shown.
        </p>
      )}
    </details>
  );
}

export function CommandOutputPanel({
  command,
  cwd,
  text,
  stream = "combined",
  exitCode,
  signal,
  state,
  truncated,
  omittedBytes,
}: {
  command?: string | null;
  cwd?: string | null;
  text: string;
  stream?: string;
  exitCode?: number | null;
  signal?: string | null;
  state: string;
  truncated?: boolean;
  omittedBytes?: number;
}) {
  const viewport = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const element = viewport.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [text]);
  return (
    <section className="activity-panel" aria-label="Command output">
      <h4>
        Command output{" "}
        <span className="activity-state">{state.replaceAll("_", " ")}</span>
      </h4>
      {command && <code className="activity-command">{command}</code>}
      {cwd && (
        <p className="note">
          Directory: <code>{cwd}</code>
        </p>
      )}
      <p className="note">
        {stream === "combined"
          ? "Combined output; stdout and stderr are not distinguished."
          : stream}
      </p>
      <pre
        className="activity-scroll activity-output"
        ref={viewport}
        tabIndex={0}
        aria-label="Scrollable command output"
        onScroll={() => {
          const element = viewport.current;
          if (!element) return;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            32;
          setFollowing(follow.current);
        }}
      >
        {text.slice(-DISPLAY_LIMIT) || "No output supplied yet."}
      </pre>
      {!following && (
        <button
          type="button"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            if (viewport.current)
              viewport.current.scrollTop = viewport.current.scrollHeight;
          }}
        >
          Follow latest output
        </button>
      )}
      {(truncated || text.length > DISPLAY_LIMIT) && (
        <p className="note">
          Output truncated
          {omittedBytes ? ` (${omittedBytes} bytes omitted upstream)` : ""}.
          Showing the retained tail.
        </p>
      )}
      <p className="note">
        {exitCode != null ? `Exit code: ${exitCode}` : "Exit code not supplied"}
        {signal ? ` · Signal: ${signal}` : ""}
      </p>
    </section>
  );
}
