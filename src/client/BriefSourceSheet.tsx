import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { apiInWorkspace } from "./api";
import { Sheet } from "./components";
import { briefSourceUrl } from "./briefView";
import { createReadableText, type DisplayAgent } from "../shared/readable-text";
import type { BriefEvidencePage } from "../shared/briefs";
import { viewOwner } from "./viewCache";
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
        const refs = [...new Set(result.cite.map((cite) => cite.ref))];
        const source = refs.length === 1 && result.sources[refs[0]];
        const href = source && briefSourceUrl(source, sourceId);
        if (href) location.assign(href);
        else setPage(result);
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
    <Sheet title="Sources" onClose={onClose}>
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
        <p role="status">Opening source…</p>
      ) : (
        <div className="status-sources">
          <p className="status-source-summary">{readable(page.text)}</p>
          {[...new Set(page.cite.map((cite) => cite.ref))].map((ref) => {
            const source = page.sources[ref],
              href = source && briefSourceUrl(source, sourceId);
            return href ? (
              <a className="status-source-link" key={ref} href={href}>
                <strong>
                  {readable(source.title)}{" "}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </strong>
                {source.at !== null && (
                  <time dateTime={new Date(source.at).toISOString()}>
                    {new Date(source.at).toLocaleString()}
                  </time>
                )}
                <p>{readable(source.excerpt)}</p>
                <span>
                  {source.kind === "checkout"
                    ? "Open recorded changes"
                    : source.kind === "verification"
                      ? "Open recorded checks"
                      : source.artifact && !source.message
                        ? "Open published result"
                        : "Open original message"}
                </span>
              </a>
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
