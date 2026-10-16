import { ArrowUpRight, Link2, Pin } from "lucide-react";
import type { BriefSource, BriefVersion, Item } from "../shared/briefs";
import { briefSourceUrl } from "./briefView";
import { useReadableText } from "./ReadableText";

export const briefItemLabels = {
  state: "State",
  decision: "Decision",
  question: "Question",
  unfinished: "Unfinished work",
};
export const briefLifecycle = {
  state: { status: "retired", label: "Retire" },
  decision: { status: "superseded", label: "Mark superseded" },
  question: { status: "answered", label: "Mark answered" },
  unfinished: { status: "done", label: "Mark done" },
};
export function itemCitations(item: Pick<Item, "cite" | "answered_cite">) {
  return [...item.cite, ...(item.answered_cite ? [item.answered_cite] : [])];
}

export function BriefItemSummary({
  item,
  author,
  replacement,
}: {
  item: Item;
  author: (id: string) => string;
  replacement?: string;
}) {
  const readable = useReadableText();
  return (
    <header className="brief-item-summary">
      <h3 className={item.status === "superseded" ? "brief-superseded" : ""}>
        {readable(item.text)}
      </h3>
      {item.why && <p className="brief-item-reason">{readable(item.why)}</p>}
      <div className="brief-detail-meta">
        {item.decided_by && (
          <span>Decided by {readable(author(item.decided_by))}</span>
        )}
        {item.asked_by && (
          <span>Asked by {readable(author(item.asked_by))}</span>
        )}
        {!item.decided_by && !item.asked_by && (
          <span>
            {item.author === "owner" ? "By you" : "From the project record"}
          </span>
        )}
        <span className="brief-item-status">{item.status}</span>
        {item.pinned && (
          <span>
            <Pin size={12} aria-hidden="true" />
            Pinned wording
          </span>
        )}
      </div>
      {item.cite_stale && (
        <p className="brief-notice">
          A source has changed. Check the original evidence.
        </p>
      )}
      {item.next && (
        <p className="brief-item-context">
          <strong>Next</strong>
          {readable(item.next)}
        </p>
      )}
      {item.blocker && (
        <p className="brief-item-context brief-blocker">
          <strong>Blocked</strong>
          {readable(item.blocker)}
        </p>
      )}
      {replacement && (
        <p className="brief-item-context">
          <strong>Replaced by</strong>
          {readable(replacement)}
        </p>
      )}
    </header>
  );
}

export function BriefEvidence({
  item,
  sources,
  workspace,
  onNavigate,
}: {
  item: Item;
  sources: Record<string, BriefSource>;
  workspace: string;
  onNavigate: (url: string) => void;
}) {
  const readable = useReadableText();
  const cites = itemCitations(item);
  return (
    <div className="brief-evidence">
      {cites.map((cite, index) => {
        const source = sources[cite.ref],
          href = source && briefSourceUrl(source, workspace);
        const excerpt =
          cite.quote ||
          source?.excerpt ||
          (source
            ? "No excerpt available."
            : "The source is no longer available.");
        const displayExcerpt = readable(excerpt);
        return (
          <article className="brief-source" key={cite.ref + index}>
            <div className="brief-source-head">
              <Link2 size={16} aria-hidden="true" />
              <div>
                <h4>
                  {source
                    ? readable(source.title || "Untitled source")
                    : "Source unavailable"}
                </h4>
                {source?.at != null && (
                  <time dateTime={new Date(source.at).toISOString()}>
                    {new Date(source.at).toLocaleString()}
                  </time>
                )}
                {index >= item.cite.length && <span>Answer evidence</span>}
              </div>
            </div>
            <blockquote>{displayExcerpt}</blockquote>
            {displayExcerpt !== excerpt && (
              <p className="muted">Open the source for the original wording.</p>
            )}
            {href ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(href);
                }}
              >
                {source.conversation
                  ? source.message
                    ? "Open thread at original message"
                    : "Open source thread"
                  : "Open published file"}
                <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            ) : (
              <p className="brief-source-unavailable">
                This source cannot be opened.
              </p>
            )}
          </article>
        );
      })}
      {!cites.length && (
        <p className="brief-empty">No evidence is available for this item.</p>
      )}
    </div>
  );
}

export type BriefHistory = { items: BriefVersion[]; before: number | null };
export function BriefHistoryList({
  history,
  pending,
  error,
  itemId,
  onRetry,
  onMore,
}: {
  history: BriefHistory | null;
  pending: boolean;
  error: string;
  itemId?: string;
  onRetry: () => void;
  onMore: () => void;
}) {
  const readable = useReadableText();
  const versions =
    history?.items.filter(
      (version) =>
        !itemId || version.changes.some((change) => change.id === itemId),
    ) ?? [];
  const fields: Record<string, string> = {
    state: "State",
    decisions: "Decision",
    open_questions: "Question",
    unfinished: "Unfinished work",
  };
  const operations = {
    added: "Added",
    changed: "Updated",
    resolved: "Resolved",
    removed: "Removed",
  };
  return (
    <div className="brief-version-list" aria-busy={pending}>
      {pending && (
        <p className="muted" role="status">
          Loading history…
        </p>
      )}
      {error && (
        <div className="brief-notice error" role="alert">
          <p>{readable(error)}</p>
          <button
            type="button"
            className="text-button"
            onClick={onRetry}
            disabled={pending}
          >
            Retry history
          </button>
        </div>
      )}
      <ol className="brief-history">
        {versions.map((version) => (
          <li key={version.version}>
            <div>
              <strong>Version {version.version}</strong>
              <time dateTime={new Date(version.at).toISOString()}>
                {new Date(version.at).toLocaleString()}
              </time>
            </div>
            <ul>
              {version.changes
                .filter((change) => !itemId || change.id === itemId)
                .map((change, index) => (
                  <li key={change.field + change.id + index}>
                    {operations[change.op]} ·{" "}
                    {fields[change.field] || change.field.replaceAll("_", " ")}
                    {change.pinned ? " · pinned wording" : ""}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ol>
      {!pending && !error && !history && (
        <button type="button" className="text-button" onClick={onRetry}>
          Load history
        </button>
      )}
      {!pending && !error && history && !versions.length && (
        <p className="brief-empty">
          {history?.before
            ? "No matching changes in these versions. Check older versions."
            : itemId
              ? "No recorded changes for this item."
              : "No recorded version history yet."}
        </p>
      )}
      {history?.before != null && (
        <button
          type="button"
          className="text-button"
          disabled={pending}
          onClick={onMore}
        >
          Older versions
        </button>
      )}
    </div>
  );
}
