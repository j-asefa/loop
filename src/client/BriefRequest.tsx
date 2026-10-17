import { ArrowUpRight } from "lucide-react";
import type { BriefSource, Item } from "../shared/briefs";
import { briefSourceUrl } from "./briefView";
import { useReadableText } from "./ReadableText";
import "./briefSources.css";

export function BriefRequest({
  summary,
  sources,
  workspace,
  onNavigate,
}: {
  summary: Item["summary"];
  sources: Record<string, BriefSource>;
  workspace: string;
  onNavigate?: (url: string) => void;
}) {
  const readable = useReadableText();
  const request = summary?.request;
  if (!request) return null;
  const source = sources[request.ref];
  const quote = request.quote?.trim();
  const href = source && briefSourceUrl(source, workspace);
  // Do not label missing, changed or automated text as the owner's words.
  if (
    !quote ||
    !source?.owner_message ||
    !source.verified_quotes?.includes(quote)
  )
    return (
      <p className="muted">The original request is no longer available.</p>
    );
  const display = readable(quote);
  return (
    <div className="brief-request">
      <span className="brief-reading-label">
        {display === quote ? "In your words" : "Your request"}
      </span>
      <blockquote>{display}</blockquote>
      {href && (
        <a
          href={href}
          onClick={(event) => {
            if (
              onNavigate &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey &&
              event.button === 0
            ) {
              event.preventDefault();
              onNavigate(href);
            }
          }}
        >
          Open your message <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
