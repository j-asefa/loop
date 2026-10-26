import { Fragment, useEffect, useState } from "react";
import { FileDiff, GitBranch } from "lucide-react";
import { Sheet } from "./components";
import { Patch } from "./PullRequests";
import { PullChangeCounts } from "./PullChangeCounts";
import { readableText } from "../shared/readable-text";
import { changePrompts } from "./threadView";
import {
  checkoutLine,
  checkoutParts,
  patchByFile,
  type CheckoutDetail,
  type CheckoutSummary,
} from "../shared/checkout";

/**
 * The checkout Loop observed for a run: one line on the card, the stored
 * patch a tap away. This is Loop's observation of the worktree, not the
 * agent's report of its edits, and nothing here applies or reverts anything.
 */
export function CheckoutChip({
  summary,
  onOpen,
  compact = false,
}: {
  summary: CheckoutSummary;
  onOpen: () => void;
  compact?: boolean;
}) {
  const historical =
    compact && summary.state === "captured" && summary.scope !== "run";
  const description = compact
    ? historical
      ? "Historical checkout comparison; changes during this run were not captured"
      : summary.state === "captured"
        ? [
            summary.files
              ? `${summary.files} ${summary.files === 1 ? "file" : "files"} +${summary.additions} −${summary.deletions}`
              : "No tracked changes",
            summary.untracked ? `${summary.untracked} untracked` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : summary.state === "failed"
          ? "Diff unavailable"
          : "Diff pending"
    : checkoutLine({
        ...summary,
        branch: readableText(summary.branch),
      });
  const count = (value: number) =>
    new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  const line = historical ? (
    "Earlier checkout"
  ) : compact && summary.state === "captured" ? (
    summary.additions || summary.deletions ? (
      <>
        <span className="diff-add-count">+{count(summary.additions)}</span>{" "}
        <span className="diff-remove-count">−{count(summary.deletions)}</span>
      </>
    ) : summary.files ? (
      `${count(summary.files)} ${summary.files === 1 ? "file" : "files"}`
    ) : summary.untracked ? (
      `${count(summary.untracked)} new`
    ) : (
      "No changes"
    )
  ) : compact ? (
    description
  ) : (
    checkoutParts({ ...summary, branch: readableText(summary.branch) }).map(
      (part, index) => (
        <Fragment key={index}>
          {index > 0 && " · "}
          {typeof part === "string" ? (
            part
          ) : (
            <>
              {part.files} {part.files === 1 ? "file" : "files"}{" "}
              <span className="diff-add-count">+{part.additions}</span>{" "}
              <span className="diff-remove-count">−{part.deletions}</span>
            </>
          )}
        </Fragment>
      ),
    )
  );
  const Icon = compact ? FileDiff : GitBranch;
  return (
    <button
      type="button"
      className="changes-chip checkout-chip"
      onClick={onOpen}
      aria-label={`${compact ? "Changes" : "Checkout"}: ${description}`}
      title={compact ? description : undefined}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{line}</span>
    </button>
  );
}

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const short = (sha: string | null) => (sha ? sha.slice(0, 10) : "unknown");

export function CheckoutSheet({
  runId,
  load,
  onClose,
  onAsk,
  agentName,
  projectName,
}: {
  runId: string;
  load: (runId: string) => Promise<CheckoutDetail>;
  onClose: () => void;
  onAsk?: (prompt: string) => void;
  agentName?: string;
  projectName?: string;
}) {
  const [detail, setDetail] = useState<CheckoutDetail | null>(null);
  const [error, setError] = useState("");
  // A capture still in progress is polled until it ends, so an open sheet
  // shows the observation without being reopened.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A failed read while waiting is retried, so a dropped connection does
    // not leave the sheet stale once it is back.
    const read = () =>
      load(runId)
        .then((result) => {
          if (!live) return;
          setDetail(result);
          setError("");
          if (result.state === "started") timer = setTimeout(read, 5000);
        })
        .catch((e: Error) => {
          if (!live) return;
          setError(e.message);
          timer = setTimeout(read, 10000);
        });
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [runId]);
  const chunks = detail?.patch
    ? patchByFile(detail.patch)
    : new Map<string, string>();
  const prompts = detail
    ? changePrompts(
        detail.files.map((file) => file.path),
        {
          projectName,
          runStartedAt: [detail.started_at],
        },
      )
    : null;
  const ask = (prompt: string) => {
    onClose();
    onAsk?.(prompt);
  };
  const notes: string[] = [];
  if (detail) {
    if (detail.summary?.scope === "run")
      notes.push(
        "Changes during this run. Pre-existing tracked edits are excluded; untracked entries list new paths only.",
      );
    else if (detail.state === "captured")
      notes.push(
        "Historical comparison against the source checkout. These totals include earlier repository changes and do not measure this run's edits.",
      );
    if (detail.start_dirty || detail.start_untracked)
      notes.push(
        "The checkout already had changes before this run started, so this record brackets an interval rather than proving which run made each change.",
      );
    if (detail.overlap.length)
      notes.push(
        `${detail.overlap.length === 1 ? "Another run was" : `${detail.overlap.length} other runs were`} active on this checkout during this run.`,
      );
    if (detail.remote)
      notes.push(
        detail.remote.contains_head === null
          ? `${detail.remote.ref} was found, but Git could not say whether it contained this checkout's HEAD when Loop looked on ${when(detail.remote.observed_at)}.`
          : `${detail.remote.ref} ${detail.remote.contains_head ? "contained" : "did not contain"} this checkout's HEAD when Loop looked on ${when(detail.remote.observed_at)}. Loop reads the local remote-tracking ref and never fetches, so this is only as current as the last fetch, and it does not say which side is ahead.`,
      );
    else if (detail.state === "captured")
      notes.push("No remote-tracking ref for this branch was found locally.");
    if (detail.captured_late)
      notes.push(
        "Captured after a restart, later than the run ended, so the checkout may have changed in between.",
      );
    if (detail.patch_truncated)
      notes.push(
        `The stored patch was shortened${detail.patch_bytes ? ` from ${Math.round(detail.patch_bytes / 1024)} KB` : ""}. Open the worktree for the full diff.`,
      );
    if (detail.error) notes.push(`Capture error: ${detail.error}`);
  }
  return (
    <Sheet title="Checkout" wide onClose={onClose} className="changes-sheet">
      {error && <p className="field-error">{readableText(error)}</p>}
      {!detail && !error && <p role="status">Loading checkout…</p>}
      {detail && (
        <>
          <div className="changes-head">
            <p className="changes-total">
              {readableText(
                detail.summary ? checkoutLine(detail.summary) : detail.branch,
              )}
            </p>
            <p className="changes-meta">
              Observed by Loop
              {detail.ended_at
                ? ` at ${when(detail.ended_at)}`
                : ` from ${when(detail.started_at)}`}
              {" · "}base {readableText(detail.base_ref ?? "unknown")}{" "}
              <code>{short(detail.base_sha)}</code>
              {" · "}start <code>{short(detail.start_head)}</code>
              {detail.end_head && (
                <>
                  {" · "}end <code>{short(detail.end_head)}</code>
                </>
              )}
            </p>
            {notes.map((note) => (
              <p key={note} className="field-hint checkout-note">
                {readableText(note)}
              </p>
            ))}
          </div>
          {detail.state === "captured" &&
            !detail.files.length &&
            !detail.untracked.length && (
              <p className="field-hint">No tracked changes against the base.</p>
            )}
          <div className="pull-files">
            {detail.files.map((f) => (
              <details
                key={f.path}
                className="pull-file"
                open={detail.files.length <= 3}
              >
                <summary>
                  <span className="pull-file-path">{f.path}</span>
                  {f.binary ? (
                    <span className="field-hint">binary</span>
                  ) : (
                    <PullChangeCounts
                      additions={f.additions}
                      deletions={f.deletions}
                    />
                  )}
                  {f.filtered && (
                    <span className="field-hint">
                      filtered content, compared raw
                    </span>
                  )}
                </summary>
                {chunks.get(f.path) ? (
                  <Patch patch={chunks.get(f.path)!} />
                ) : (
                  <p className="field-hint">
                    {f.binary
                      ? "Binary content is not shown."
                      : "This file's diff is not in the stored patch."}
                  </p>
                )}
              </details>
            ))}
          </div>
          {detail.untracked.length > 0 && (
            <>
              <p className="changes-meta">
                Untracked files (content not captured)
              </p>
              <ul className="checkout-untracked">
                {detail.untracked.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {onAsk &&
            prompts &&
            detail.state === "captured" &&
            detail.summary?.scope === "run" &&
            detail.files.length > 0 && (
              <>
                <div className="changes-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => ask(prompts.commit)}
                  >
                    Ask to commit
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => ask(prompts.pr)}
                  >
                    Ask for a PR
                  </button>
                  <button
                    type="button"
                    className="secondary danger"
                    onClick={() => ask(prompts.revert)}
                  >
                    Ask to revert
                  </button>
                </div>
                <p className="field-hint">
                  Fills in an editable prompt asking @{agentName || "the agent"}{" "}
                  to check the full diff first. Nothing is sent until you send
                  it.
                </p>
              </>
            )}
        </>
      )}
    </Sheet>
  );
}
