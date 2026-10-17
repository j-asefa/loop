import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { apiInWorkspace } from "./api";
import { Sheet } from "./components";
import { briefSourceUrl } from "./briefView";
import { createReadableText, type DisplayAgent } from "../shared/readable-text";
import type { BriefEvidencePage } from "../shared/briefs";
import { viewOwner } from "./viewCache";
import { ReadableTextProvider } from "./ReadableText";
import { BriefRequest } from "./BriefRequest";
import { briefStageLabels } from "../shared/brief-reading";
import "./briefSources.css";

export type BriefEvidenceTarget = { item: string; version?: number | null };

/** Resolve the current, owner-scoped evidence only when the reader asks for it. */
export function BriefSourceSheet({
  project,
  target,
  sourceId,
  agents,
  onClose,
}: {
  project: string;
  target: BriefEvidenceTarget;
  sourceId: string;
  agents: readonly DisplayAgent[];
  onClose: () => void;
}) {
  const [page, setPage] = useState<BriefEvidencePage | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const readable = createReadableText(agents);
  useEffect(() => {
    let active = true;
    const owner = viewOwner(),
      controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setPage(null);
    setError("");
    const query = new URLSearchParams({ item: target.item });
    if (target.version) query.set("version", String(target.version));
    void apiInWorkspace<BriefEvidencePage>(
      `/projects/${encodeURIComponent(project)}/brief/evidence?${query}`,
      sourceId,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!active || owner !== viewOwner()) return;
        setPage(result);
      })
      .catch((failure) => {
        if (active && owner === viewOwner()) setError(failure.message);
      });
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [project, target.item, target.version, sourceId, attempt]);
  return (
    <Sheet title="Request & sources" onClose={onClose}>
      {error ? (
        <div role="alert">
          <p>{readable(error)}</p>
          <button
            className="text-button"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      ) : !page ? (
        <p role="status">Loading sources…</p>
      ) : (
        <div className="status-sources">
          <div className="status-source-summary">
            <h3>{readable(page.summary?.title ?? page.text)}</h3>
            {(page.summary?.update || page.update) && (
              <p>{readable(page.summary?.update ?? page.update ?? "")}</p>
            )}
            {page.summary?.stage && (
              <small>{briefStageLabels[page.summary.stage]}</small>
            )}
          </div>
          <ReadableTextProvider agents={agents}>
            <BriefRequest
              summary={page.summary}
              sources={page.sources}
              workspace={sourceId}
            />
          </ReadableTextProvider>
          {page.next && (
            <p className="brief-reading-next">
              <strong>Next</strong>
              {readable(page.next)}
            </p>
          )}
          {page.blocker && (
            <p className="brief-reading-next">
              <strong>Blocked by</strong>
              {readable(page.blocker)}
            </p>
          )}
          {page.summary && (
            <details className="brief-reading-context">
              <summary>More context</summary>
              <p>{readable(page.text)}</p>
            </details>
          )}
          <span className="brief-reading-label">Supporting record</span>
          {[...new Set(page.cite.map((cite) => cite.ref))].map((ref) => {
            const source = page.sources[ref],
              href = source && briefSourceUrl(source, sourceId);
            return href ? (
              <article className="status-source-link" key={ref}>
                <a href={href}>
                  <strong>
                    {readable(source.title)}{" "}
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </strong>
                </a>
                {source.at !== null && (
                  <time dateTime={new Date(source.at).toISOString()}>
                    {new Date(source.at).toLocaleString()}
                  </time>
                )}
                <details className="brief-reading-context">
                  <summary>Read original text</summary>
                  <p>{readable(source.excerpt)}</p>
                </details>
                <a href={href}>
                  {source.kind === "checkout"
                    ? "Open recorded changes"
                    : source.kind === "verification"
                      ? "Open recorded checks"
                      : source.artifact && !source.message
                        ? "Open published result"
                        : "Open original message"}
                </a>
              </article>
            ) : (
              <p key={ref} className="muted">
                This source is no longer available in this project.
              </p>
            );
          })}
          {!page.cite.length && (
            <p className="muted">No sources were recorded for this item.</p>
          )}
        </div>
      )}
    </Sheet>
  );
}
