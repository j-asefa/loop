import { readRoute } from "./api";
import { useCollectionRead } from "./CollectionRead";
import { viewGeneration } from "./viewCache";
import { ConversationId } from "../shared/contract-ids.js";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, GitPullRequest, RefreshCw } from "lucide-react";
import { workspaceApi } from "../shared/workspace-api";
import type {
  ConversationPull,
  ConversationPulls as Pulls,
} from "../shared/conversation-pulls";
import { pullRequestKey, pullRequestUrl } from "../shared/github";
import { useSourceId } from "./SourceContext";
import { executionSourceId } from "./sourceRouting";
import { listenWorkspaceChanges } from "./workspace-changes";
import { openPull } from "./PullRequests";
import { PullChangeCounts } from "./PullChangeCounts";
import { PULL_STATE_LABEL, PULL_REVIEW_LABEL } from "./pullLabels";

const reviews = {
  ...PULL_REVIEW_LABEL,
  commented: "Commented",
  dismissed: "Review dismissed",
};

export function ConversationPullCard({
  pull,
  onOpen,
}: {
  pull: ConversationPull;
  onOpen?: () => void;
}) {
  return (
    <li className="conversation-pull">
      <div className="pr-card-heading">
        <span>{pullRequestKey(pull)}</span>
        {pull.state && (
          <span className={`pr-state ${pull.state}`}>
            {PULL_STATE_LABEL[pull.state]}
          </span>
        )}
      </div>
      {pull.title && <strong>{pull.title}</strong>}
      {pull.error ? (
        <p className="field-hint" role="status">
          {pull.error}
        </p>
      ) : (
        <>
          {pull.review && (
            <p className="conversation-pull-review">{reviews[pull.review]}</p>
          )}
          {!!pull.requested?.length && (
            <p>Review requested: {pull.requested.join(", ")}</p>
          )}
          {!!pull.reviews?.length && (
            <ul className="conversation-pull-reviewers">
              {pull.reviews.map((r) => (
                <li key={r.author}>
                  @{r.author}: {reviews[r.state]}
                  {r.headSha && r.headSha !== pull.headSha
                    ? " (earlier commit)"
                    : ""}
                </li>
              ))}
            </ul>
          )}
          {pull.reviews?.length === 0 &&
            !pull.review &&
            !pull.reviewsOmitted && (
              <p className="field-hint">No reviews yet</p>
            )}
          {pull.reviewsOmitted && (
            <p className="field-hint">More review information on GitHub.</p>
          )}
          {pull.fetchedAt !== undefined && (
            <>
              <PullChangeCounts {...pull} />
              <p className="field-hint">
                Updated {new Date(pull.fetchedAt).toLocaleString()}
              </p>
            </>
          )}
        </>
      )}
      <div className="conversation-pull-actions">
        {onOpen && (
          <button className="text-button" onClick={onOpen}>
            Open pull request
          </button>
        )}
        <a
          href={pullRequestUrl(pull)}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub <ArrowUpRight size={13} />
        </a>
      </div>
    </li>
  );
}

/** One current PR section per thread, separate from historical run results. */
export function ConversationPulls({
  conversationId,
  refreshKey = "",
}: {
  conversationId: string;
  refreshKey?: string;
}) {
  const source = useSourceId();
  // Remount the reader at the source boundary: late reads cannot leak a PR
  // from a previous conversation or a different linked workspace.
  return (
    <PullReader
      key={`${source}:${conversationId}`}
      conversationId={conversationId}
      refreshKey={refreshKey}
    />
  );
}

function PullReader({
  conversationId,
  refreshKey,
}: {
  conversationId: string;
  refreshKey: string;
}) {
  const source = useSourceId();
  const scope = JSON.stringify([viewGeneration(), source, conversationId]);
  const [snapshot, setSnapshot] = useState<{ scope: string; data: Pulls }>();
  const [revision, setRevision] = useState(0);
  const forcedRevision = useRef(0);
  const {
    load: read,
    error: failure,
    busy,
  } = useCollectionRead(JSON.stringify([scope, revision, refreshKey]));
  const data = snapshot?.scope === scope ? snapshot.data : undefined;
  const error = failure
    ? "Could not refresh pull requests. Any details below are from the last successful read."
    : "";
  useEffect(() => {
    const load = (refresh = false) => {
      if (document.visibilityState === "hidden") return;
      void read(
        (signal) =>
          readRoute(
            workspaceApi.conversationPulls,
            {
              params: { id: ConversationId.parse(conversationId) },
              query: refresh ? { refresh: "1" } : {},
            },
            source,
            signal,
            undefined,
            "once",
          ),
        (next) => setSnapshot({ scope, data: next }),
      );
    };
    const force = revision !== forcedRevision.current;
    forcedRevision.current = revision;
    void load(force);
    const refresh = () => {
      void load();
    };
    const interval = window.setInterval(refresh, 60_000);
    const stop = listenWorkspaceChanges(
      "pulls",
      refresh,
      source,
      conversationId,
    );
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(interval);
      stop();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [conversationId, source, scope, revision, refreshKey, read]);
  if (!data?.pulls.length && !error) return null;
  const first = data?.pulls[0];
  const canOpen = (source || "") === (executionSourceId() || "");
  return (
    <details className="conversation-pulls">
      <summary>
        <GitPullRequest size={16} aria-hidden="true" />
        <span>
          {first
            ? `${pullRequestKey(first)}${first.title ? ` · ${first.title}` : ""}`
            : "Pull requests"}
        </span>
        {first?.state && (
          <span className={`pr-state ${first.state}`}>
            {PULL_STATE_LABEL[first.state]}
          </span>
        )}
        {first?.review && !error ? (
          <small>{reviews[first.review]}</small>
        ) : (
          !!first?.reviews?.length &&
          !error && (
            <small>
              {first.reviews.length} reviewer
              {first.reviews.length === 1 ? "" : "s"}
            </small>
          )
        )}
        {(data?.pulls.length ?? 0) > 1 && (
          <small>+{data!.pulls.length - 1}</small>
        )}
        {(error || first?.error) && <small>Refresh failed</small>}
      </summary>
      <div className="conversation-pulls-body">
        <button
          className="text-button"
          disabled={busy}
          onClick={() => setRevision((r) => r + 1)}
        >
          <RefreshCw size={14} /> {busy ? "Refreshing…" : "Refresh"}
        </button>
        {error && (
          <p className="field-hint" role="status">
            {error}
          </p>
        )}
        {data && !data.connected && (
          <p className="field-hint">
            Connect GitHub in Tools to see current PR and review details.
          </p>
        )}
        <ul className="conversation-pulls-list">
          {data?.pulls.map((pull) => (
            <ConversationPullCard
              key={pullRequestKey(pull)}
              pull={pull}
              onOpen={
                canOpen && data.connected ? () => openPull(pull) : undefined
              }
            />
          ))}
        </ul>
        {data?.hasMore && (
          <p className="field-hint">
            Showing 20 pull requests mentioned in this conversation.
          </p>
        )}
      </div>
    </details>
  );
}
