import { useProjectionRead } from "./SourceContext";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleDot,
  Eye,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { api } from "./api";
import { listenWorkspaceChanges } from "./workspace-changes";
import { executionSourceId } from "./sourceRouting";
import { PullChangeCounts } from "./PullChangeCounts";
import { Empty, RichText, Sheet } from "./components";
import { relativeTime } from "./threadView";
import { RepoFileSheet } from "./RepoFileView";
import {
  parsePullRequestUrl,
  type PullRequestRef,
  type PullRequestState,
} from "../shared/github";
import {
  MAX_REVIEW_BODY,
  PULL_FILTERS,
  type ChecksState,
  type MergeMethod,
  type PullComment,
  type PullCommitFiles,
  type PullFile,
  type PullDetail,
  type PullFiles,
  type PullFilter,
  type PullInbox,
  type PullListItem,
  type ReviewDecision,
} from "../shared/pull-requests";

// The Pull requests tab: your open pull requests across GitHub, read and
// acted on directly, without asking an agent. Everything shown comes from
// GitHub at the time it was read; Refresh reads it again.

/** The page's address for one pull request: owner/repo/number. */
export const pullKey = (ref: PullRequestRef) =>
  `${ref.owner}/${ref.repo}/${ref.number}` as const;
export function pullFromKey(key: string): PullRequestRef | undefined {
  const match = key.match(
    /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(\d{1,9})$/,
  );
  if (!match || !Number(match[3])) return;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}
/** Opens a pull request in the Pull requests tab from anywhere in Loop. */
export const OPEN_PULL = "loop-open-pull";
/** Tools closed: GitHub may have been connected or removed there. */
export const TOOLS_CLOSED = "loop-tools-closed";
export function openPull(ref: PullRequestRef) {
  window.dispatchEvent(new CustomEvent(OPEN_PULL, { detail: pullKey(ref) }));
}

const pullPath = (ref: PullRequestRef) =>
  `/github/pulls/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}` as const;

const STATE_LABEL: Record<PullRequestState, string> = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};
const CHECKS_LABEL: Record<ChecksState, string> = {
  success: "Checks passed",
  failure: "Checks failed",
  pending: "Checks running",
};
const CHECKS_TONE: Record<ChecksState, string> = {
  success: "passed",
  failure: "failed",
  pending: "queued",
};
const REVIEW_LABEL: Record<ReviewDecision, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
};
const REVIEW_TONE: Record<ReviewDecision, string> = {
  approved: "passed",
  changes_requested: "needs",
  review_required: "idle",
};
const METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};
const at = (value?: string) => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? "" : relativeTime(time).toLowerCase();
};

function StatusChips({ pr }: { pr: PullListItem }) {
  return (
    <>
      {pr.checks && (
        <span className={"status-chip " + CHECKS_TONE[pr.checks]}>
          {CHECKS_LABEL[pr.checks]}
        </span>
      )}
      {pr.review && (
        <span className={"status-chip " + REVIEW_TONE[pr.review]}>
          {REVIEW_LABEL[pr.review]}
        </span>
      )}
    </>
  );
}

export function PullRequests({
  selected,
  onSelect,
  onConnect,
  onAsk,
}: {
  /** The open pull request's key, or "" for the list. */
  selected: string;
  onSelect: (key: string) => void;
  onConnect: () => void;
  /** Starts a message to an agent about a pull request; absent without agents. */
  onAsk?: (text: string) => void;
}) {
  const ref = pullFromKey(selected);
  return ref ? (
    <PullRequestDetail
      key={selected}
      pullRef={ref}
      onBack={() => onSelect("")}
      onConnect={onConnect}
      onAsk={onAsk}
    />
  ) : (
    <PullRequestInbox onSelect={onSelect} onConnect={onConnect} />
  );
}

// The list keeps its last read while you look at a pull request, so going
// back shows it at once; Refresh or a new filter reads GitHub again.
let lastInbox: { key: string; inbox: PullInbox } | undefined;

function PullRequestInbox({
  onSelect,
  onConnect,
}: {
  onSelect: (key: string) => void;
  onConnect: () => void;
}) {
  const read = useProjectionRead();
  const [filter, setFilterState] = useState<PullFilter>(
    () =>
      (PULL_FILTERS.find(
        (f) => f.id === sessionStorage.getItem("loop-pull-filter"),
      )?.id as PullFilter) || PULL_FILTERS[0].id,
  );
  const [repo, setRepo] = useState(
    () => sessionStorage.getItem("loop-pull-repo") || "",
  );
  const [terms, setTerms] = useState("");
  const [input, setInput] = useState("");
  const key = JSON.stringify([filter, repo, terms]);
  const [inbox, setInbox] = useState<PullInbox | null>(
    lastInbox?.key === key ? lastInbox.inbox : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = async () => {
    const mine = ++request.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ filter });
      if (repo) params.set("repo", repo);
      if (terms) params.set("q", terms);
      const result = await read<PullInbox>(`/github/pulls?${params}`);
      if (mine !== request.current) return;
      // Only a connected read is kept: connecting GitHub must show at once.
      lastInbox = result.connected ? { key, inbox: result } : undefined;
      setInbox(result);
    } catch (e) {
      if (mine === request.current) setError((e as Error).message);
    } finally {
      if (mine === request.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (lastInbox?.key === key) setInbox(lastInbox.inbox);
    else void load();
  }, [key]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("loop-refresh", refresh);
    window.addEventListener(TOOLS_CLOSED, refresh);
    const stopChanges = listenWorkspaceChanges(
      "pulls",
      refresh,
      executionSourceId(),
    );
    return () => {
      stopChanges();
      window.removeEventListener("loop-refresh", refresh);
      window.removeEventListener(TOOLS_CLOSED, refresh);
    };
  });
  const setFilter = (value: PullFilter) => {
    setFilterState(value);
    sessionStorage.setItem("loop-pull-filter", value);
  };
  const chooseRepo = (value: string) => {
    setRepo(value);
    sessionStorage.setItem("loop-pull-repo", value);
  };
  // One box: a pull request link opens it, owner/repo narrows the list to a
  // repository, and anything else filters by text.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    const value = input.trim();
    const link = parsePullRequestUrl(value);
    if (link) {
      setInput("");
      return onSelect(pullKey(link));
    }
    if (/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(value)) {
      setInput("");
      return chooseRepo(value);
    }
    setTerms(value);
  };
  if (inbox && !inbox.connected)
    return (
      <section className="pulls-view">
        <Empty
          title="Connect GitHub to see your pull requests."
          action={
            <div className="actions">
              <button className="primary" onClick={onConnect}>
                Connect GitHub
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void load()}
              >
                Check again
              </button>
            </div>
          }
        >
          Loop reads your open pull requests with the GitHub connection in
          Tools. Reviews, comments and merges you make here are posted as your
          GitHub account.
        </Empty>
      </section>
    );
  const connected = inbox?.connected ? inbox : undefined;
  return (
    <section className="pulls-view">
      <div className="pulls-head">
        <p className="muted">
          {connected
            ? `Open pull requests for @${connected.login}, as of ${new Date(connected.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
            : "Reading GitHub…"}
        </p>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load()}
          aria-label="Refresh pull requests"
        >
          <RefreshCw size={16} className={busy ? "spin" : ""} /> Refresh
        </button>
      </div>
      <form className="search-box" role="search" onSubmit={submit}>
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          enterKeyHint="search"
          aria-label="Filter pull requests, or paste a pull request link"
          placeholder="Filter, owner/repo, or paste a PR link"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (!e.target.value.trim() && terms) setTerms("");
          }}
        />
      </form>
      <div className="chip-row" aria-label="Show">
        {PULL_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {connected && connected.counts[f.id] > 0 && (
              <span className="chip-count">
                {connected.counts[f.id] > 99 ? "99+" : connected.counts[f.id]}
              </span>
            )}
          </button>
        ))}
        {repo && (
          <button
            type="button"
            className="chip"
            aria-pressed="true"
            aria-label={`Showing ${repo} only. Show all repositories`}
            onClick={() => chooseRepo("")}
          >
            {repo} <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {connected &&
        (connected.pulls.length ? (
          <ul className="pulls-list">
            {connected.pulls.map((pr) => (
              <li key={pr.url}>
                <button
                  className="pull-row"
                  onClick={() => onSelect(pullKey(pr))}
                >
                  <span className="pull-row-heading">
                    <GitPullRequest size={15} aria-hidden="true" />
                    <span className="pull-row-repo">
                      {pr.owner}/{pr.repo} #{pr.number}
                    </span>
                    <span className={"pr-state " + pr.state}>
                      {STATE_LABEL[pr.state]}
                    </span>
                  </span>
                  <strong className="pull-row-title">{pr.title}</strong>
                  <span className="pull-row-meta">
                    {[
                      pr.author && "@" + pr.author,
                      pr.updatedAt && "updated " + at(pr.updatedAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    <PullChangeCounts {...pr} />
                    {!!pr.comments && (
                      <span
                        className="pull-row-comments"
                        aria-label={`${pr.comments} comments`}
                      >
                        <MessageSquare size={13} aria-hidden="true" />
                        {pr.comments}
                      </span>
                    )}
                  </span>
                  {(pr.checks || pr.review) && (
                    <span className="pull-row-status">
                      <StatusChips pr={pr} />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            title={
              terms || repo
                ? "No open pull requests match."
                : filter === "review"
                  ? "Nothing is waiting for your review."
                  : filter === "authored"
                    ? "You have no open pull requests."
                    : "No open pull requests involve you."
            }
          >
            {filter === "review"
              ? "Pull requests where your review is requested appear here."
              : "Paste a pull request link above to open any pull request."}
          </Empty>
        ))}
      {connected && connected.total > connected.pulls.length && (
        <p className="pr-card-note">
          Showing the {connected.pulls.length} most recently updated of{" "}
          {connected.total}. Filter by repository or text to narrow the list.
        </p>
      )}
    </section>
  );
}

function Reviews({ pr }: { pr: PullDetail }) {
  return (
    <section className="pull-section">
      <h3>Reviews</h3>
      {pr.reviewsOmitted && pr.reviews.length > 0 && (
        <p className="pr-card-note">
          Showing {pr.reviews.length} reviews from the latest 50. Older reviews
          may be available.{" "}
          <a href={pr.url} target="_blank" rel="noopener noreferrer">
            Read them all on GitHub
          </a>
          .
        </p>
      )}
      {pr.reviews.length ? (
        pr.reviews.map((r, i) => (
          <Comment key={i} comment={r} state={r.state} />
        ))
      ) : (
        <p className="muted">
          {pr.reviewsOmitted
            ? "No reviews shown from the latest 50. Older reviews may be available on GitHub."
            : "No reviews yet."}
        </p>
      )}
    </section>
  );
}

function Comment({ comment, state }: { comment: PullComment; state?: string }) {
  return (
    <article className="pull-comment">
      <header>
        <strong>@{comment.author || "ghost"}</strong>
        {state && (
          <span
            className={
              "status-chip " +
              (state === "approved"
                ? "passed"
                : state === "changes_requested"
                  ? "needs"
                  : "idle")
            }
          >
            {state === "approved"
              ? "Approved"
              : state === "changes_requested"
                ? "Changes requested"
                : state === "dismissed"
                  ? "Dismissed"
                  : "Commented"}
          </span>
        )}
        {!comment.member && (
          <span className="pull-comment-outside">Outside the repository</span>
        )}
        {comment.url ? (
          <a href={comment.url} target="_blank" rel="noopener noreferrer">
            {at(comment.createdAt)}
          </a>
        ) : (
          <span>{at(comment.createdAt)}</span>
        )}
      </header>
      {comment.body.trim() ? (
        <RichText content={comment.body} diagrams={false} compact />
      ) : (
        <p className="muted">No comment.</p>
      )}
    </article>
  );
}

// A unified diff hunk with line numbers from its hunk headers.
export function Patch({ patch }: { patch: string }) {
  let left = 0,
    right = 0;
  const rows = patch.split("\n").map((line, i) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      return { line, kind: "hunk", number: "", i };
    }
    if (line.startsWith("+"))
      return { line, kind: "add", number: String(right++), i };
    if (line.startsWith("-"))
      return { line, kind: "del", number: String(left++), i };
    if (line.startsWith("\\")) return { line, kind: "meta", number: "", i };
    left++;
    return { line, kind: "", number: String(right++), i };
  });
  return (
    <div className="pull-diff" role="region" aria-label="Diff" tabIndex={0}>
      <pre>
        {rows.map((row) => (
          <span key={row.i} className={"pull-diff-line " + row.kind}>
            <span className="pull-diff-number" aria-hidden="true">
              {row.number}
            </span>
            {row.line || " "}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

// The diffs of exactly the head commit shown above: the server refuses if the
// head moved, and the detail view remounts this list on every read, so a
// Refresh never leaves an older commit's diffs under a newer head.
function FileList({
  pullRef,
  url,
  headSha,
}: {
  pullRef: PullRequestRef;
  url: string;
  headSha: string;
}) {
  const [data, setData] = useState<PullFiles | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<PullFiles>(
      `${pullPath(pullRef)}/files?head=${encodeURIComponent(headSha)}`,
    )
      .then((result) => live && setData(result))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!data || data.headSha !== headSha)
    return <p className="muted">Reading the changed files…</p>;
  return (
    <ChangedFiles
      pullRef={pullRef}
      sha={headSha}
      files={data.files}
      url={url + "/files"}
      hasMore={data.files.length >= 300}
    />
  );
}

function ChangedFiles({
  pullRef,
  sha,
  files,
  url,
  hasMore,
}: {
  pullRef: PullRequestRef;
  sha: string;
  files: PullFile[];
  url: string;
  hasMore: boolean;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  if (!files.length) return <p className="muted">No changed files.</p>;
  // Small pull requests open every diff; larger ones start collapsed.
  const lines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const expand = files.length <= 8 && lines <= 600;
  return (
    <div className="pull-files">
      {files.map((f) => (
        <details key={f.path} className="pull-file" open={expand}>
          <summary>
            <span className={"pull-file-status " + f.status}>{f.status}</span>
            <span className="pull-file-path">
              {f.previousPath && f.previousPath !== f.path
                ? `${f.previousPath} → ${f.path}`
                : f.path}
            </span>
            <PullChangeCounts additions={f.additions} deletions={f.deletions} />
          </summary>
          {f.status !== "removed" && (
            <button
              type="button"
              className="text-button pull-file-view"
              onClick={() => setViewing(f.path)}
            >
              <Eye size={16} aria-hidden="true" /> View file
            </button>
          )}
          {f.patch ? (
            <>
              <Patch patch={f.patch} />
              {f.truncated && (
                <p className="field-hint">
                  This diff was shortened.{" "}
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    See all of it on GitHub
                  </a>
                  .
                </p>
              )}
            </>
          ) : (
            <p className="field-hint">
              GitHub doesn’t show this diff here (binary or too large)
              {f.status !== "removed"
                ? ", but you can view the file"
                : ""}.{" "}
              <a href={url} target="_blank" rel="noopener noreferrer">
                Open the files on GitHub
              </a>
              .
            </p>
          )}
        </details>
      ))}
      {viewing && (
        <RepoFileSheet
          pullRef={pullRef}
          headSha={sha}
          path={viewing}
          onClose={() => setViewing(null)}
        />
      )}
      {hasMore && (
        <p className="pr-card-note">
          Showing the first 300 files.{" "}
          <a href={url} target="_blank" rel="noopener noreferrer">
            See the rest on GitHub
          </a>
          .
        </p>
      )}
    </div>
  );
}

function CommitChanges({
  pullRef,
  commit,
}: {
  pullRef: PullRequestRef;
  commit: PullDetail["commitHistory"][number];
}) {
  const [data, setData] = useState<PullCommitFiles | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    api<PullCommitFiles>(`${pullPath(pullRef)}/commits/${commit.sha}/files`)
      .then((result) => {
        if (result.sha.toLowerCase() !== commit.sha.toLowerCase())
          throw new Error(
            "GitHub did not return this commit's changes. Try again.",
          );
        if (live) setData(result);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [attempt, pullRef.owner, pullRef.repo, pullRef.number, commit.sha]);
  if (error)
    return (
      <div role="alert">
        <p className="error">{error}</p>
        <button className="text-button" onClick={() => setAttempt(attempt + 1)}>
          Try again
        </button>
      </div>
    );
  if (!data)
    return (
      <p className="muted" role="status">
        Reading this commit’s changes…
      </p>
    );
  return (
    <ChangedFiles
      pullRef={pullRef}
      sha={commit.sha}
      files={data.files}
      url={commit.url}
      hasMore={data.hasMore}
    />
  );
}

function CommitEntry({
  pullRef,
  commit,
}: {
  pullRef: PullRequestRef;
  commit: PullDetail["commitHistory"][number];
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="pull-file"
      onToggle={(event) => {
        // Nested file disclosures also emit toggle events in some browsers.
        if (event.target === event.currentTarget && event.currentTarget.open)
          setOpened(true);
      }}
    >
      <summary>
        <span className="pull-commit-title">
          {commit.message.split("\n")[0]}
        </span>
        <span className="pull-commit-meta muted">
          {commit.author || "Unknown author"} · {at(commit.committedAt)} ·{" "}
          <a
            href={commit.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            <code>{commit.sha.slice(0, 7)}</code> View commit on GitHub
          </a>
        </span>
      </summary>
      {commit.message.includes("\n") && (
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {commit.message.slice(commit.message.indexOf("\n") + 1).trim()}
        </p>
      )}
      {opened && <CommitChanges pullRef={pullRef} commit={commit} />}
    </details>
  );
}

type Action = "review" | "comment" | "merge";

function PullRequestDetail({
  pullRef,
  onBack,
  onConnect,
  onAsk,
}: {
  pullRef: PullRequestRef;
  onBack: () => void;
  onConnect: () => void;
  onAsk?: (text: string) => void;
}) {
  const read = useProjectionRead();
  const [pr, setPr] = useState<PullDetail | null>(null);
  const [error, setError] = useState<{ message: string; status?: number }>();
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<
    "overview" | "files" | "commits" | "conversation"
  >("overview");
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState("");
  const load = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPr(await read<PullDetail>(pullPath(pullRef)));
    } catch (e) {
      setError({
        message: (e as Error).message,
        status: (e as { status?: number }).status,
      });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("loop-refresh", refresh);
    const stopChanges = listenWorkspaceChanges(
      "pulls",
      refresh,
      executionSourceId(),
    );
    return () => {
      stopChanges();
      window.removeEventListener("loop-refresh", refresh);
    };
  });
  const name = `${pullRef.owner}/${pullRef.repo}#${pullRef.number}`;
  const back = (
    <button className="text-button" onClick={onBack}>
      <ArrowLeft size={17} /> All pull requests
    </button>
  );
  if (!pr)
    return (
      <section className="pulls-view">
        {back}
        {error ? (
          <div className="error" role="alert">
            <p>{error.message}</p>
            {/connect github|reconnect github/i.test(error.message) ? (
              <button className="text-button" onClick={onConnect}>
                Open Tools
              </button>
            ) : (
              <button className="text-button" onClick={() => void load()}>
                Try again
              </button>
            )}
          </div>
        ) : (
          <p className="muted">Reading {name} from GitHub…</p>
        )}
      </section>
    );
  const open = pr.state === "open" || pr.state === "draft";
  const unresolved = pr.threads.filter((t) => !t.resolved).length;
  // Past the threads Loop reads, the count is a lower bound.
  const someThreads = pr.threadsTotal > pr.threads.length;
  const failing = pr.checkRuns.filter((c) => c.state === "failure");
  const done = (message: string) => {
    setAction(null);
    setNotice(message);
    void load();
  };
  return (
    <section className="pulls-view pull-detail">
      {back}
      <header className="pull-detail-head">
        <p className="pull-row-heading">
          <GitPullRequest size={16} aria-hidden="true" />
          <span className="pull-row-repo">
            {pr.owner}/{pr.repo} #{pr.number}
          </span>
          <span className={"pr-state " + pr.state}>
            {STATE_LABEL[pr.state]}
          </span>
        </p>
        <h2>{pr.title}</h2>
        <p className="muted">
          {pr.author ? `@${pr.author}` : "Someone"} wants to merge{" "}
          {pr.commits !== undefined &&
            `${pr.commits} commit${pr.commits === 1 ? "" : "s"} `}
          from <code>{pr.headRef}</code> into <code>{pr.baseRef}</code>
        </p>
        <dl className="pr-card-facts">
          <div>
            <dt>Head</dt>
            <dd>
              <code title={pr.headSha}>{pr.headSha.slice(0, 7)}</code>
            </dd>
          </div>
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
          {pr.requested.length > 0 && (
            <div>
              <dt>Review requested</dt>
              <dd>
                {pr.requested
                  .map((r) => (r.startsWith("team ") ? r : "@" + r))
                  .join(", ")}
              </dd>
            </div>
          )}
        </dl>
        <p className="pull-row-status">
          <StatusChips pr={pr} />
          {pr.conflicts && (
            <span className="status-chip failed">Merge conflicts</span>
          )}
          {unresolved > 0 && (
            <span className="status-chip needs">
              {unresolved}
              {someThreads ? "+" : ""} unresolved thread
              {unresolved === 1 && !someThreads ? "" : "s"}
            </span>
          )}
        </p>
        <p className="pr-card-note">
          As of {new Date(pr.fetchedAt).toLocaleTimeString()}.{" "}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw size={14} className={busy ? "spin" : ""} /> Refresh
          </button>{" "}
          <a href={pr.url} target="_blank" rel="noopener noreferrer">
            Open on GitHub <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </p>
      </header>
      {error && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      <div
        className="pull-actions actions"
        role="group"
        aria-label="Act on this pull request"
      >
        {open && (
          <button className="primary" onClick={() => setAction("review")}>
            <Check size={16} /> Review
          </button>
        )}
        <button className="secondary" onClick={() => setAction("comment")}>
          <MessageSquare size={16} /> Comment
        </button>
        {open && pr.viewer.canMerge && (
          <button className="secondary" onClick={() => setAction("merge")}>
            <GitMerge size={16} /> Merge…
          </button>
        )}
        {onAsk && (
          <button
            className="secondary"
            onClick={() =>
              onAsk(`Review ${pr.url} and tell me what needs attention.`)
            }
          >
            <MessageSquarePlus size={16} /> Ask an agent
          </button>
        )}
      </div>
      <div className="segmented" role="group" aria-label="Pull request view">
        {(
          [
            ["overview", "Overview"],
            [
              "files",
              `Files${pr.changedFiles !== undefined ? ` (${pr.changedFiles})` : ""}`,
            ],
            [
              "commits",
              `Commits${pr.commits !== undefined ? ` (${pr.commits})` : ""}`,
            ],
            [
              "conversation",
              `Conversation (${pr.conversationTotal + pr.threadsTotal + pr.reviewsTotal})`,
            ],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={page === value ? "selected" : ""}
            aria-pressed={page === value}
            onClick={() => setPage(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {page === "overview" && (
        <>
          <section className="pull-section">
            <h3>Description</h3>
            {pr.body.trim() ? (
              <div className="pull-body">
                <RichText content={pr.body} diagrams={false} />
              </div>
            ) : (
              <p className="muted">No description.</p>
            )}
          </section>
          <section className="pull-section">
            <h3>Checks</h3>
            {pr.checkRuns.length ? (
              <ul className="pull-checks">
                {[
                  ...failing,
                  ...pr.checkRuns.filter((c) => c.state !== "failure"),
                ].map((c, i) => (
                  <li key={c.name + i}>
                    <span
                      className={
                        "status-chip " +
                        (c.state === "failure"
                          ? "failed"
                          : c.state === "pending"
                            ? "queued"
                            : c.state === "success"
                              ? "passed"
                              : "done")
                      }
                    >
                      {c.state === "failure"
                        ? "Failed"
                        : c.state === "pending"
                          ? "Running"
                          : c.state === "skipped"
                            ? "Skipped"
                            : c.state === "neutral"
                              ? "Neutral"
                              : "Passed"}
                    </span>
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noopener noreferrer">
                        {c.name}
                      </a>
                    ) : (
                      <span>{c.name}</span>
                    )}
                    {c.description && (
                      <small className="muted">{c.description}</small>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No checks reported on the head commit.</p>
            )}
          </section>
          <Reviews pr={pr} />
        </>
      )}
      {page === "files" && (
        <FileList
          key={`${pr.headSha}:${pr.fetchedAt}`}
          pullRef={pullRef}
          url={pr.url}
          headSha={pr.headSha}
        />
      )}
      {page === "commits" && (
        <section className="pull-section">
          <h3>Commits</h3>
          {(pr.commits ?? 0) > pr.commitHistory.length && (
            <p className="pr-card-note">
              Showing the latest {pr.commitHistory.length} of {pr.commits}{" "}
              commits.{" "}
              <a
                href={pr.url + "/commits"}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read them all on GitHub
              </a>
              .
            </p>
          )}
          {pr.commitHistory.length ? (
            pr.commitHistory.map((commit) => (
              <CommitEntry
                key={`${commit.sha}:${pr.fetchedAt}`}
                pullRef={pullRef}
                commit={commit}
              />
            ))
          ) : (
            <p className="muted">No commits shown.</p>
          )}
        </section>
      )}
      {page === "conversation" && (
        <>
          <Reviews pr={pr} />
          {pr.threads.length > 0 && (
            <section className="pull-section">
              <h3>Review threads</h3>
              {someThreads && (
                <p className="pr-card-note">
                  Showing {pr.threads.length} of {pr.threadsTotal} review
                  threads; there may be more unresolved.{" "}
                  <a
                    href={pr.url + "/files"}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Read them all on GitHub
                  </a>
                  .
                </p>
              )}
              {[...pr.threads]
                .sort((a, b) => Number(a.resolved) - Number(b.resolved))
                .map((t) => (
                  <details
                    key={t.id}
                    className="pull-thread"
                    open={!t.resolved}
                  >
                    <summary>
                      <code>
                        {t.path}
                        {t.line ? `:${t.line}` : ""}
                      </code>
                      {t.resolved && (
                        <span className="status-chip done">Resolved</span>
                      )}
                      {t.outdated && (
                        <span className="status-chip idle">Outdated</span>
                      )}
                    </summary>
                    {t.comments.map((c, i) => (
                      <Comment key={i} comment={c} />
                    ))}
                    {t.commentsTotal > t.comments.length && (
                      <p className="pr-card-note">
                        {t.commentsTotal - t.comments.length} more{" "}
                        {t.commentsTotal - t.comments.length === 1
                          ? "reply"
                          : "replies"}{" "}
                        not shown.{" "}
                        <a
                          href={t.comments[0].url || pr.url + "/files"}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Read the thread on GitHub
                        </a>
                        .
                      </p>
                    )}
                  </details>
                ))}
            </section>
          )}
          <section className="pull-section">
            <h3>Comments</h3>
            {pr.conversationTotal > pr.conversation.length && (
              <p className="pr-card-note">
                Showing the latest {pr.conversation.length} of{" "}
                {pr.conversationTotal}.{" "}
                <a href={pr.url} target="_blank" rel="noopener noreferrer">
                  Read them all on GitHub
                </a>
                .
              </p>
            )}
            {pr.conversation.length ? (
              pr.conversation.map((c, i) => <Comment key={i} comment={c} />)
            ) : (
              <p className="muted">No comments yet.</p>
            )}
            <button className="secondary" onClick={() => setAction("comment")}>
              <MessageSquare size={16} /> Add a comment
            </button>
          </section>
        </>
      )}
      {action === "review" && (
        <ReviewSheet pr={pr} onClose={() => setAction(null)} onDone={done} />
      )}
      {action === "comment" && (
        <CommentSheet pr={pr} onClose={() => setAction(null)} onDone={done} />
      )}
      {action === "merge" && (
        <MergeSheet pr={pr} onClose={() => setAction(null)} onDone={done} />
      )}
    </section>
  );
}

// Errors from an action keep the sheet open with what you wrote; a 409 means
// the pull request moved on and needs a fresh look.
function useSubmit(onDone: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onDone(await work());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function ReviewSheet({
  pr,
  onClose,
  onDone,
}: {
  pr: PullDetail;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [event, setEvent] = useState<"approve" | "request_changes" | "comment">(
    pr.viewer.author ? "comment" : "approve",
  );
  const [body, setBody] = useState("");
  const { busy, error, run } = useSubmit(onDone);
  const choices = [
    [
      "approve",
      "Approve",
      pr.viewer.author
        ? "You can’t approve your own pull request."
        : "Approve merging these changes.",
    ],
    [
      "request_changes",
      "Request changes",
      pr.viewer.author
        ? "You can’t request changes on your own pull request."
        : "Feedback that must be addressed before merging.",
    ],
    ["comment", "Comment", "General feedback without approving."],
  ] as const;
  return (
    <Sheet
      title={`Review ${pr.owner}/${pr.repo}#${pr.number}`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`${pullPath(pr)}/reviews`, {
              event,
              body,
              headSha: pr.headSha,
            });
            return event === "approve"
              ? "You approved this pull request on GitHub."
              : event === "request_changes"
                ? "You requested changes on GitHub."
                : "Your review comment is on GitHub.";
          });
        }}
      >
        <fieldset className="pr-choices" disabled={busy}>
          <legend>Your review</legend>
          {choices.map(([value, label, hint]) => {
            const blocked = pr.viewer.author && value !== "comment";
            return (
              <label key={value} className={event === value ? "selected" : ""}>
                <input
                  type="radio"
                  name="review"
                  checked={event === value}
                  disabled={blocked}
                  onChange={() => setEvent(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </label>
            );
          })}
        </fieldset>
        <label>
          {event === "approve" ? "Comment (optional)" : "Comment"}
          <textarea
            rows={5}
            maxLength={MAX_REVIEW_BODY}
            value={body}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <p className="field-hint">
          Posted to GitHub as @{pr.viewer.login} on commit{" "}
          <code>{pr.headSha.slice(0, 7)}</code>. If anything was pushed since
          you opened this, Loop asks you to look at it first.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || (event !== "approve" && !body.trim())}
          >
            {busy ? "Submitting…" : "Submit review"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function CommentSheet({
  pr,
  onClose,
  onDone,
}: {
  pr: PullDetail;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [body, setBody] = useState("");
  const { busy, error, run } = useSubmit(onDone);
  return (
    <Sheet
      title={`Comment on ${pr.owner}/${pr.repo}#${pr.number}`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`${pullPath(pr)}/comments`, { body });
            return "Your comment is on GitHub.";
          });
        }}
      >
        <label>
          Comment
          <textarea
            rows={6}
            maxLength={MAX_REVIEW_BODY}
            value={body}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <p className="field-hint">Posted to GitHub as @{pr.viewer.login}.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !body.trim()}>
            {busy ? "Posting…" : "Post comment"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function MergeSheet({
  pr,
  onClose,
  onDone,
}: {
  pr: PullDetail;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [method, setMethod] = useState<MergeMethod | undefined>(
    pr.mergeMethods[0],
  );
  const { busy, error, run } = useSubmit(onDone);
  // What GitHub reported when you opened the pull request. GitHub enforces
  // its own rules on the merge; these say why it may refuse.
  const warnings = [
    pr.state === "draft" && "This pull request is still a draft.",
    pr.conflicts && "It has merge conflicts with the base branch.",
    pr.checks === "failure" && "Some checks failed.",
    pr.checks === "pending" && "Some checks are still running.",
    pr.review === "changes_requested" && "A reviewer requested changes.",
    pr.review === "review_required" && "It still needs an approving review.",
    pr.mergeState === "blocked" &&
      "GitHub reports it as blocked by the repository’s rules.",
    pr.mergeState === "behind" && "The branch is behind its base.",
  ].filter((w): w is string => !!w);
  const blocked = pr.state === "draft" || pr.conflicts || !method;
  return (
    <Sheet
      title={`Merge ${pr.owner}/${pr.repo}#${pr.number}?`}
      onClose={onClose}
    >
      <p>
        <strong>{pr.title}</strong>
      </p>
      <dl className="pull-merge-facts">
        <div>
          <dt>Into</dt>
          <dd>
            <code>{pr.baseRef}</code> from <code>{pr.headRef}</code>
          </dd>
        </div>
        <div>
          <dt>Head commit</dt>
          <dd>
            <code title={pr.headSha}>{pr.headSha.slice(0, 12)}</code>
          </dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>{pr.checks ? CHECKS_LABEL[pr.checks] : "None reported"}</dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd>{pr.review ? REVIEW_LABEL[pr.review] : "No review required"}</dd>
        </div>
      </dl>
      {warnings.length > 0 && (
        <div className="note pull-merge-warnings" role="status">
          <CircleDot size={15} aria-hidden="true" />
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {pr.mergeMethods.length ? (
        <label>
          Merge method
          <select
            value={method}
            disabled={busy}
            onChange={(e) => setMethod(e.target.value as MergeMethod)}
          >
            {pr.mergeMethods.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="error">
          This repository allows no merge method Loop can use.
        </p>
      )}
      <p className="field-hint">
        Merges commit <code>{pr.headSha.slice(0, 7)}</code> only, as @
        {pr.viewer.login}. If anything was pushed after you opened this, GitHub
        refuses and you can look at the new commits first.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || blocked}
          onClick={() =>
            void run(async () => {
              await api(`${pullPath(pr)}/merge`, {
                method,
                headSha: pr.headSha,
              });
              return `Merged into ${pr.baseRef}.`;
            })
          }
        >
          <GitMerge size={16} />{" "}
          {busy ? "Merging…" : method ? METHOD_LABEL[method] : "Merge"}
        </button>
      </div>
    </Sheet>
  );
}
