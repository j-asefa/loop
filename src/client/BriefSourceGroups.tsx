import { ArrowUpRight } from "lucide-react";
import type { BriefEvidencePage, BriefSource } from "../shared/briefs";
import { briefSourceUrl } from "./briefView";

function sourceLabel(source: BriefSource) {
  switch (source.kind) {
    case "checkout":
      return "Recorded changes";
    case "verification":
      return "Recorded checks";
    case "deployment":
      return "Running build observation";
    case "result":
      return "Agent’s response";
    case "approval":
      return "Approval";
    case "pr":
      return "Pull request update";
    case "saved":
      return "Saved record";
    default:
      return source.owner_message ? "Your request" : "Message";
  }
}

/** Group by conversation identity, never by a potentially shared title. */
export function BriefSourceGroups({
  cites,
  sources,
  workspace,
  readable,
}: {
  cites: BriefEvidencePage["cite"];
  sources: BriefEvidencePage["sources"];
  workspace: string;
  readable: (text: string) => string;
}) {
  const groups = new Map<string, { title?: string; refs: string[] }>();
  for (const ref of new Set(cites.map((cite) => cite.ref))) {
    const source = sources[ref];
    const key = source?.conversation
      ? `thread:${source.conversation}`
      : `source:${ref}`;
    const group = groups.get(key) ?? { title: source?.title, refs: [] };
    group.refs.push(ref);
    groups.set(key, group);
  }
  return (
    <>
      {[...groups].map(([key, group]) => (
        <section className="status-source-group" key={key}>
          {group.title !== undefined && (
            <h4>{readable(group.title || "Untitled source")}</h4>
          )}
          {group.refs.map((ref) => {
            const source = sources[ref];
            const href = source && briefSourceUrl(source, workspace);
            if (!href)
              return (
                <p key={ref} className="muted">
                  This source is no longer available in this project.
                </p>
              );
            return (
              <article className="status-source-link" key={ref}>
                <strong>{sourceLabel(source)}</strong>
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
                        : source.message
                          ? "Open original message"
                          : "Open source thread"}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </article>
            );
          })}
        </section>
      ))}
    </>
  );
}
