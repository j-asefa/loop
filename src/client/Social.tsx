import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  MessageSquare,
  MessageSquarePlus,
  Plus,
} from "lucide-react";
import { api } from "./api";
import { Sheet } from "./components";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { relativeTime } from "./threadView";
import {
  feedById,
  feedCatalog,
  type FeedEntry,
  type SocialResponse,
} from "../shared/news";

/** The Hacker News mark: an orange tile with a white Y, like the site's header. */
function HackerNewsMark({ label }: { label: string }) {
  return (
    <span className="avatar generated news-mark" role="img" aria-label={label}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <rect width="40" height="40" rx="12" fill="#ff6600" />
        <path
          d="M13 11h4.2l2.8 6.6 2.8-6.6H27l-5 10.4V29h-4v-7.6z"
          fill="#fff"
        />
      </svg>
    </span>
  );
}

/** Reddit's mark: an orange-red disc with a white face, like its app icon. */
function RedditMark({ label }: { label: string }) {
  return (
    <span className="avatar generated news-mark" role="img" aria-label={label}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="20" fill="#ff4500" />
        <ellipse cx="20" cy="23.5" rx="10" ry="7" fill="#fff" />
        <circle cx="28.5" cy="12" r="2.4" fill="#fff" />
        <path
          d="M20 16.5l1.8-6 6.7 1.5"
          stroke="#fff"
          strokeWidth="1.6"
          fill="none"
        />
        <circle cx="16.3" cy="22.5" r="1.7" fill="#ff4500" />
        <circle cx="23.7" cy="22.5" r="1.7" fill="#ff4500" />
        <path
          d="M15.8 26.4q4.2 2.6 8.4 0"
          stroke="#ff4500"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </span>
  );
}


/** A feed's mark: the site's own for Hacker News and Reddit, else its initial. */
function FeedMark({ feed }: { feed: FeedEntry }) {
  if (feed.home === "news.ycombinator.com" || feed.home === "hnrss.org")
    return <HackerNewsMark label={feed.name} />;
  if (feed.home === "reddit.com") return <RedditMark label={feed.name} />;
  return (
    <span
      className="avatar generated news-mark feed-initial"
      role="img"
      aria-label={feed.name}
      style={{ background: feed.color }}
    >
      {feed.name.replace(/^(The|r\/)\s*/, "").charAt(0).toUpperCase()}
    </span>
  );
}

const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

const categories = ["All", ...new Set(feedCatalog.map((f) => f.category))];

/** The feeds Social can show, each added or removed with one button. */
function FeedCatalog({
  added,
  busy,
  onToggle,
}: {
  added: string[];
  busy: string;
  onToggle: (feed: FeedEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const words = query.trim().toLowerCase();
  const entries = feedCatalog.filter(
    (feed) =>
      (category === "All" || feed.category === category) &&
      (!words ||
        [feed.name, feed.description, feed.home, feed.category]
          .join(" ")
          .toLowerCase()
          .includes(words)),
  );
  return (
    <section className="feed-catalog" aria-label="Feed catalog">
      <label>
        Search feeds
        <input
          type="search"
          placeholder="Hacker News, Reddit, science…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="chip-row" role="group" aria-label="Category">
        {categories.map((value) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={category === value}
            onClick={() => setCategory(value)}
          >
            {value}
          </button>
        ))}
      </div>
      {!entries.length && <p>No matching feeds. Try another search.</p>}
      <div className="catalog-grid">
        {entries.map((feed) => {
          const isAdded = added.includes(feed.id);
          return (
            <article
              className="catalog-card feed-catalog-card"
              key={feed.id}
              aria-label={feed.name}
            >
              <div className="catalog-card-title">
                <span className="identity">
                  <FeedMark feed={feed} />
                  <span>
                    <h4>{feed.name}</h4>
                    <p className="field-hint">{feed.home}</p>
                  </span>
                </span>
                <span className="catalog-badge">
                  {isAdded ? "Added" : feed.category}
                </span>
              </div>
              <p>{feed.description}</p>
              <div className="actions catalog-install">
                <button
                  type="button"
                  className={isAdded ? "secondary" : "primary"}
                  aria-label={
                    isAdded ? `Remove ${feed.name}` : `Add ${feed.name}`
                  }
                  disabled={!!busy}
                  onClick={() => onToggle(feed)}
                >
                  {busy === feed.id ? "Saving…" : isAdded ? "Remove" : "Add"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type Shown = SocialResponse & { added: string[] };

/**
 * Social: stories from every feed you added, newest first, as Feed cards.
 * Links open the item or its discussion on the source; "Ask an agent" starts
 * a message about it. With no feeds yet it shows the catalog to pick from.
 */
export function Social({ onAsk }: { onAsk?: (text: string) => void }) {
  const KEY = "social";
  const shown = cachedView<Shown>(KEY);
  const [view, setView] = useState<Shown | null>(shown || null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [choosing, setChoosing] = useState(false);
  // Picking first feeds from the empty Social keeps the catalog open until Done.
  const [picking, setPicking] = useState(false);
  const request = useRef(0);
  async function load() {
    const ticket = ++request.current;
    const owner = viewOwner();
    try {
      const [{ added }, social] = await Promise.all([
        api<{ added: string[] }>("/social/feeds"),
        api<SocialResponse>("/social"),
      ]);
      if (ticket !== request.current || owner !== viewOwner()) return;
      const next = { ...social, added };
      setView(next);
      cacheView<Shown>(KEY, next, owner);
      setError("");
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    }
  }
  async function toggle(feed: FeedEntry) {
    const adding = !view?.added.includes(feed.id);
    setBusy(feed.id);
    try {
      const { added } = await api<{ added: string[] }>(
        `/social/feeds/${feed.id}`,
        undefined,
        adding ? "PUT" : "DELETE",
      );
      if (adding && !view?.added.length) setPicking(true);
      setView((old) => old && { ...old, added });
      setError("");
      void load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    void load();
    // The server refreshes each feed every five minutes; so does the list.
    const timer = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  const errorBox = error && (
    <div className="error" role="alert">
      {error}
      <button className="text-button" onClick={() => void load()}>
        Try again
      </button>
    </div>
  );
  if (!view)
    return (
      errorBox || (
        <div className="feed-loading" role="status" aria-label="Loading Social">
          <span />
          <span />
          <span />
        </div>
      )
    );
  const catalog = (
    <FeedCatalog added={view.added} busy={busy} onToggle={toggle} />
  );
  if (!view.added.length || picking)
    return (
      <>
        {errorBox}
        <div className="social-intro">
          <div>
            <p>
              <strong>Add feeds to Social.</strong>
            </p>
            <p className="field-hint">
              Pick sites and communities to follow. Their newest posts show
              here as cards, newest first.
            </p>
          </div>
          {!!view.added.length && (
            <button
              type="button"
              className="primary"
              onClick={() => setPicking(false)}
            >
              Done · {plural(view.added.length, "feed")}
            </button>
          )}
        </div>
        {catalog}
      </>
    );
  const failed = view.failed
    .map((id) => feedById.get(id)?.name)
    .filter(Boolean);
  return (
    <>
      <div className="social-toolbar">
        <span className="field-hint">
          {plural(view.added.length, "feed")}
        </span>
        <button
          type="button"
          className="text-button"
          onClick={() => setChoosing(true)}
        >
          <Plus size={16} />
          Add feeds
        </button>
      </div>
      {choosing && (
        <Sheet title="Add feeds" wide onClose={() => setChoosing(false)}>
          {catalog}
        </Sheet>
      )}
      {errorBox}
      {!!failed.length && (
        <p className="field-hint" role="status">
          Couldn’t load {failed.join(", ")}. Trying again shortly.
        </p>
      )}
      {view.stories.length ? (
        <ul className="inbox-list feed news-list" aria-label="Social">
          {view.stories.map((story) => {
            const feed = feedById.get(story.feed);
            if (!feed) return null;
            return (
              <li key={story.id}>
                <article className="feed-card news-card">
                  <div className="card-byline">
                    <span className="identity">
                      <FeedMark feed={feed} />
                      <span>
                        <strong>{story.community || feed.name}</strong>
                        <span className="subline">
                          {story.author && <span>by {story.author}</span>}
                          {story.published_at && (
                            <time
                              dateTime={new Date(
                                story.published_at,
                              ).toISOString()}
                            >
                              {relativeTime(story.published_at)}
                            </time>
                          )}
                        </span>
                      </span>
                    </span>
                  </div>
                  <div className="card-content">
                    <span className="eyebrow inbox-eyebrow">
                      {feed.kind.charAt(0).toUpperCase() + feed.kind.slice(1)}
                      <span className="card-project">
                        {" "}
                        · {story.site || feed.home}
                      </span>
                    </span>
                    <h2>
                      <a
                        href={story.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {story.title}
                      </a>
                    </h2>
                    {story.summary && (
                      <p className="news-summary">{story.summary}</p>
                    )}
                    {(story.points !== null || story.comments !== null) && (
                      <p className="field-hint news-stats">
                        {[
                          story.points !== null &&
                            plural(story.points, "point"),
                          story.comments !== null &&
                            plural(story.comments, "comment"),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="card-actions">
                    <a
                      href={story.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ArrowUpRight size={16} />
                      Open
                    </a>
                    {story.comments_url && (
                      <a
                        href={story.comments_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <MessageSquare size={16} />
                        Discussion
                      </a>
                    )}
                    {onAsk && (
                      <button
                        onClick={() =>
                          onAsk(
                            `About this ${feed.name} ${feed.kind}: ${story.title}\n${story.url}` +
                              (story.comments_url &&
                              story.comments_url !== story.url
                                ? `\nDiscussion: ${story.comments_url}`
                                : "") +
                              "\n\n",
                          )
                        }
                      >
                        <MessageSquarePlus size={16} />
                        Ask an agent
                      </button>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="inbox-empty">
          <p>
            <strong>No posts right now.</strong>
          </p>
        </div>
      )}
    </>
  );
}
