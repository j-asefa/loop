import { useMemo, useState, type ReactNode } from "react";
import { Rss, Sparkles, X } from "lucide-react";
import { SocialFeedId } from "../shared/contract-ids.js";
import { starterFeeds } from "../shared/feed-starter";
import { workspaceApi } from "../shared/workspace-api";
import { callRoute } from "./api";
import { emitClientEvent } from "./clientEvents";
import { ErrorNotice } from "./ErrorNotice";
import { FeedMark } from "./FeedMark";
import { notify } from "./toast";
import { viewGeneration, viewOwner } from "./viewCache";

/**
 * Calm, opt-in starter card shown only on a brand-new empty Feed (no agent work
 * and no followed feeds). Disappears automatically once real cards or followed
 * feeds exist, or when dismissed.
 */
export function FeedStarterCard({
  firstTaskAction,
  onFeedsAdded,
  onOpenSocial,
  onDismiss,
}: {
  firstTaskAction?: ReactNode;
  onFeedsAdded: () => void;
  onOpenSocial?: () => void;
  onDismiss: () => void;
}) {
  const feeds = useMemo(() => starterFeeds(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addStarterFeeds() {
    if (busy || !feeds.length) return;
    const owner = viewOwner();
    const generation = viewGeneration();
    setBusy(true);
    setError("");
    try {
      const results = await Promise.allSettled(
        feeds.map((feed) =>
          callRoute(
            workspaceApi.socialFeedAdd,
            { params: { id: SocialFeedId.parse(feed.id) } },
            "",
          ),
        ),
      );
      if (generation !== viewGeneration() || owner !== viewOwner()) return;
      const addedCount = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (addedCount > 0) {
        emitClientEvent("loop-social-read");
        onFeedsAdded();
        notify({
          text:
            addedCount === feeds.length
              ? `Added ${addedCount} starter feeds.`
              : `Added ${addedCount} of ${feeds.length} starter feeds.`,
        });
      }
      if (failed) {
        setError(
          (failed.reason as Error)?.message ||
            "Some starter feeds could not be added.",
        );
      }
    } finally {
      if (generation === viewGeneration() && owner === viewOwner())
        setBusy(false);
    }
  }

  return (
    <section
      className="feed-card feed-starter-card"
      aria-label="Get started with Loop"
    >
      <div className="feed-starter-head">
        <div>
          <h2>Start your feed</h2>
          <p className="field-hint">
            Send your first task to an agent, or follow a few starter feeds to
            read and react to right here.
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss starter card"
          onClick={onDismiss}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="feed-starter-paths">
        {firstTaskAction && (
          <div className="feed-starter-path">
            <h3>1. Run an agent task</h3>
            <p className="field-hint">
              Finished answers arrive here as cards you can read, save, and
              continue.
            </p>
            <div>{firstTaskAction}</div>
          </div>
        )}

        <div className="feed-starter-path">
          <h3>
            {firstTaskAction
              ? "2. Follow starter feeds"
              : "Follow starter feeds"}
          </h3>
          <ul className="feed-starter-list">
            {feeds.map((feed) => (
              <li key={feed.id}>
                <FeedMark feed={feed} />
                <span>{feed.name}</span>
              </li>
            ))}
          </ul>
          <div className="feed-starter-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void addStarterFeeds()}
            >
              <Rss size={16} aria-hidden="true" />
              {busy ? "Adding feeds…" : "Add starter feeds"}
            </button>
            {onOpenSocial && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={onOpenSocial}
              >
                <Sparkles size={15} aria-hidden="true" />
                Browse feeds or set up a daily digest
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <ErrorNotice role="alert">{error}</ErrorNotice>}
    </section>
  );
}
