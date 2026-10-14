import { useSourceApi } from "./SourceContext";
import { useEffect, useState } from "react";
import { ArrowUpRight, Eye, GitPullRequest, PanelRight } from "lucide-react";
import type { PullRequestCard, PullRequestSummary } from "../shared/github";
import { parse } from "./api";
import { PullChangeCounts } from "./PullChangeCounts";
import { openPull } from "./PullRequests";

export type Watch = {
  id: string;
  repo_owner: string;
  repo_name: string;
  number: number;
  state: "watching" | "paused" | "stopped";
  ended_reason: string | null;
  error: string | null;
  head_sha: string | null;
  ci_sha: string | null;
  ci_conclusion: string | null;
  ci_pending: number;
  read_at: number | null;
  updated_at: number;
};
const WATCH_CHANGE = "loop-pr-watch-change";

// The thread's watches, kept current while a card shows them.
export function useWatches(conversation: string | null | undefined) {
  const api = useSourceApi();
  const [watches, setWatches] = useState<Watch[]>([]);
  useEffect(() => {
    if (!conversation) return;
    let live = true;
    const load = () =>
      api<{ watches: Watch[] }>(
        "/pr-watches?conversation=" + encodeURIComponent(conversation),
      )
        .then((r) => live && setWatches(r.watches))
        .catch(() => {});
    void load();
    window.addEventListener(WATCH_CHANGE, load);
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      window.removeEventListener(WATCH_CHANGE, load);
      clearInterval(timer);
    };
  }, [conversation]);
  return watches;
}

/**
 * Watch: CI results, reviews and comments on this pull request come back to
 * the thread as follow-ups. It ends on merge or close.
 */
function WatchControl({ watch }: { watch?: Watch }) {
  const api = useSourceApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      window.dispatchEvent(new Event(WATCH_CHANGE));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = () =>
    act(() => api(`/pr-watches/${watch!.id}`, undefined, "DELETE"));
  const active = watch && watch.state !== "stopped";
  if (!active && !watch) return null;
  return (
    <div className="pr-watch" role="group" aria-label="Watch pull request">
      {watch?.state === "watching" ? (
        <>
          <p className="pr-watch-status">
            <Eye size={14} aria-hidden="true" /> Watching. CI results, reviews
            and comments come back to this thread.
          </p>
          <button className="text-button" disabled={busy} onClick={stop}>
            Stop watching
          </button>
        </>
      ) : watch?.state === "paused" ? (
        <>
          <p className="pr-watch-status paused">{watch.error}</p>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => act(() => api(`/pr-watches/${watch.id}/resume`, {}))}
          >
            Resume
          </button>
          <button className="text-button" disabled={busy} onClick={stop}>
            Stop watching
          </button>
        </>
      ) : (
        <>
          {watch?.ended_reason && (
            <p className="pr-watch-status">
              Stopped watching: {watch.ended_reason}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

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

function PullRequestRow({
  pr,
  watch,
}: {
  pr: PullRequestSummary;
  watch?: Watch;
}) {
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
        {(pr.changedFiles !== undefined ||
          pr.additions !== undefined ||
          pr.deletions !== undefined) && (
          <div>
            <dt>Changes</dt>
            <dd>
              <PullChangeCounts {...pr} />
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
      <button className="text-button pr-card-open" onClick={() => openPull(pr)}>
        <PanelRight size={14} aria-hidden="true" /> Open in Pull requests
      </button>
      {watch && <WatchControl watch={watch} />}
    </li>
  );
}

// PR cards show what GitHub reported when the tool ran. Refreshing is a new
// tool call (ask the agent), so the fetch time is always visible; Open in
// Pull requests reads the pull request now and lets you act on it yourself.
export function PullRequestCards({
  card,
  compact,
  artifactId,
  conversationId,
}: {
  card: PullRequestCard;
  compact?: boolean;
  /** The card's saved result in a thread. */
  artifactId?: string;
  conversationId?: string | null;
}) {
  const watchable = !!artifactId && !!conversationId;
  const watches = useWatches(watchable ? conversationId : null);
  const shown = compact ? card.pulls.slice(0, 3) : card.pulls;
  const watchFor = (pr: PullRequestSummary) => {
    const matching = watches.filter(
      (w) =>
        w.repo_owner.toLowerCase() === pr.owner.toLowerCase() &&
        w.repo_name.toLowerCase() === pr.repo.toLowerCase() &&
        w.number === pr.number,
    );
    // An active watch wins over earlier stopped ones (newest first).
    return matching.find((w) => w.state !== "stopped") || matching[0];
  };
  const total = card.total ?? card.pulls.length;
  return (
    <div className="pr-cards">
      <ul>
        {shown.map((pr) => (
          <PullRequestRow
            key={pr.url}
            pr={pr}
            watch={watchFor(pr)}
          />
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
