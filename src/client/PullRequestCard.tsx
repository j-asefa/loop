import { ArrowUpRight, GitPullRequest } from "lucide-react";
import type { PullRequestCard, PullRequestSummary } from "../shared/github";
import { parse } from "./api";

const STATE_LABEL: Record<PullRequestSummary["state"], string> = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

// Card data comes from a saved tool result; anything malformed falls back to
// the artifact's plain text rather than rendering partial PR facts.
export function pullRequestCardData(content: string) {
  const value = parse<PullRequestCard | null>(content, null);
  return value?.type === "github_pull_requests" && Array.isArray(value.pulls)
    ? value
    : undefined;
}

function PullRequestRow({ pr }: { pr: PullRequestSummary }) {
  const changes =
    pr.additions !== undefined && pr.deletions !== undefined
      ? `+${pr.additions} −${pr.deletions}`
      : undefined;
  return (
    <li className="pr-card">
      <div className="pr-card-heading">
        <GitPullRequest size={16} aria-hidden="true" />
        <span className="pr-card-repo">
          {pr.owner}/{pr.repo} #{pr.number}
        </span>
        <span className={"pr-state " + pr.state}>{STATE_LABEL[pr.state]}</span>
      </div>
      <a
        className="pr-card-title"
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {pr.title}
        <ArrowUpRight size={13} aria-label="Opens on GitHub" />
      </a>
      <dl className="pr-card-facts">
        {pr.author && (
          <div>
            <dt>Author</dt>
            <dd>@{pr.author}</dd>
          </div>
        )}
        {pr.headRef && (
          <div>
            <dt>Branch</dt>
            <dd>
              {pr.headRef}
              {pr.baseRef ? ` → ${pr.baseRef}` : ""}
            </dd>
          </div>
        )}
        {pr.headSha && (
          <div>
            <dt>Head</dt>
            <dd>
              <code>{pr.headSha.slice(0, 7)}</code>
            </dd>
          </div>
        )}
        {(changes || pr.changedFiles !== undefined) && (
          <div>
            <dt>Changes</dt>
            <dd>
              {[
                pr.changedFiles !== undefined &&
                  `${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}`,
                changes,
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        )}
        {pr.mergeable && pr.state === "open" && (
          <div>
            <dt>Merge status</dt>
            <dd>{pr.mergeable}</dd>
          </div>
        )}
        {pr.reviewers && (
          <div>
            <dt>Review requested</dt>
            <dd>{pr.reviewers.map((r) => "@" + r).join(", ")}</dd>
          </div>
        )}
      </dl>
    </li>
  );
}

// PR cards show what GitHub reported when the tool ran. Refreshing is a new
// tool call (ask the agent), so the fetch time is always visible.
export function PullRequestCards({
  card,
  compact,
}: {
  card: PullRequestCard;
  compact?: boolean;
}) {
  const shown = compact ? card.pulls.slice(0, 3) : card.pulls;
  const total = card.total ?? card.pulls.length;
  return (
    <div className="pr-cards">
      <ul>
        {shown.map((pr) => (
          <PullRequestRow key={pr.url} pr={pr} />
        ))}
      </ul>
      <p className="pr-card-note">
        {total > shown.length && `Showing ${shown.length} of ${total}. `}
        As of {new Date(card.fetchedAt).toLocaleString()}. Ask the agent to
        refresh.
      </p>
    </div>
  );
}
