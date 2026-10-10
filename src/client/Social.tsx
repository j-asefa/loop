import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Bookmark,
  Check,
  CheckCheck,
  ChevronDown,
  Download,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  Bell,
  EyeOff,
  Rss,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { api } from "./api";
import { Sheet } from "./components";
import { LaterSheet, undoReminder, useSwipe } from "./ThreadTools";
import { notify } from "./toast";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { relativeTime } from "./threadView";
import {
  feedById,
  feedCatalog,
  type FeedEntry,
  type SocialResponse,
  type SocialStory,
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

/** GitHub's mark: the dark tile and its silhouette, like the site's own. */
function GitHubMark({ label }: { label: string }) {
  return (
    <span className="avatar generated news-mark" role="img" aria-label={label}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <rect width="40" height="40" rx="12" fill="#24292f" />
        <path
          d="M20 8a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.8.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C25.2 9.6 26.2 10 26.2 10c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 20 8z"
          fill="#fff"
        />
      </svg>
    </span>
  );
}

/** YouTube's mark: the red tile and its play triangle, like its app icon. */
function YouTubeMark({ label }: { label: string }) {
  return (
    <span className="avatar generated news-mark" role="img" aria-label={label}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <rect y="7" width="40" height="26" rx="8" fill="#ff0000" />
        <path d="M17 14.5l9 5.5-9 5.5z" fill="#fff" />
      </svg>
    </span>
  );
}

const marks = {
  hn: HackerNewsMark,
  reddit: RedditMark,
  github: GitHubMark,
  youtube: YouTubeMark,
};

/**
 * A feed's mark: the site's own where it has one, else its initial on its
 * colour. A catalog entry names its mark; a feed someone added by address is
 * recognised by its host.
 */
function FeedMark({ feed }: { feed: FeedEntry }) {
  const named = feed.mark && marks[feed.mark];
  if (named) return named({ label: feed.name });
  if (feed.home === "news.ycombinator.com" || feed.home === "hnrss.org")
    return <HackerNewsMark label={feed.name} />;
  if (feed.home === "reddit.com") return <RedditMark label={feed.name} />;
  if (feed.home === "github.com") return <GitHubMark label={feed.name} />;
  if (feed.home === "youtube.com") return <YouTubeMark label={feed.name} />;
  return (
    <span
      className="avatar generated news-mark feed-initial"
      role="img"
      aria-label={feed.name}
      style={{ background: feed.color }}
    >
      {feed.name
        .replace(/^(The|r\/)\s*/, "")
        .charAt(0)
        .toUpperCase()}
    </span>
  );
}

const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/**
 * The story a `?social=` link points at. A notification about a watched word
 * opens Social here, on the story it matched.
 */
export function openedStory() {
  const value = new URLSearchParams(location.search).get("social") || "";
  return /^[a-z0-9][\w.:-]{0,160}:.{1,500}$/i.test(value) ? value : "";
}

/** Stops pointing at a story, in state and in the address. */
function forgetStory(setFocused: (value: string) => void) {
  setFocused("");
  const url = new URL(location.href);
  url.searchParams.delete("social");
  history.replaceState(null, "", url.pathname + url.search);
}

const catalogCategories = [
  ...new Set(feedCatalog.map((feed) => feed.category)),
];

// Feeds that were still loading when the page was sent are asked for again a
// few times, so the list fills in without waiting for the next refresh.
const FILL_IN_MS = 1500;
const FILL_IN_POLLS = 8;

/**
 * Add a feed Loop doesn't ship: a feed address, or a site's, in which case the
 * feeds that page advertises are offered. Also brings a reader's whole list in
 * as OPML, and takes it out again.
 */
function AddByUrl({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [choices, setChoices] = useState<{ url: string; title: string }[]>([]);
  async function add(address: string) {
    setBusy(address);
    setError("");
    try {
      await api("/social/sources", { url: address }, "PUT");
      setUrl("");
      setChoices([]);
      onAdded();
      notify({ text: "Feed added." });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function find() {
    const address = url.trim();
    if (!address) return;
    setBusy(address);
    setError("");
    setChoices([]);
    try {
      const { candidates } = await api<{
        candidates: { url: string; title: string }[];
      }>("/social/sources/discover", { url: address }, "POST");
      // One feed and it is the address itself: just add it.
      if (candidates.length === 1 && candidates[0].url === address)
        return void (await add(address));
      if (!candidates.length) setError("No feed found at that address.");
      setChoices(candidates);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function importOpml(file: File) {
    setBusy("opml");
    setError("");
    try {
      const { added, skipped } = await api<{
        added: number;
        skipped: { url: string; reason: string }[];
      }>("/social/opml", { opml: await file.text() }, "POST");
      onAdded();
      notify({
        text: `Added ${plural(added, "feed")}${
          skipped.length ? `, skipped ${skipped.length}` : ""
        }.`,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="add-feed" aria-label="Add a feed by address">
      <label>
        Feed or site address
        <span className="add-feed-row">
          <input
            type="url"
            inputMode="url"
            placeholder="https://jvns.ca or …/releases.atom"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void find()}
          />
          <button
            type="button"
            className="primary"
            disabled={!!busy || !url.trim()}
            onClick={() => void find()}
          >
            {busy && busy !== "opml" ? "Reading…" : "Add"}
          </button>
        </span>
      </label>
      <p className="field-hint">
        Any public feed: a blog, a Bluesky or Mastodon account, a repository's
        releases.atom, a YouTube channel.
      </p>
      {!!choices.length && (
        <div className="action-list add-feed-choices">
          {choices.map((choice) => (
            <button
              key={choice.url}
              type="button"
              disabled={!!busy}
              onClick={() => void add(choice.url)}
            >
              <Rss size={20} />
              <span>
                {choice.title}
                <small>{choice.url}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="field-hint" role="alert">
          {error}
        </p>
      )}
      <div className="actions add-feed-opml">
        <label className="text-button">
          <Upload size={16} />
          Import OPML
          <input
            type="file"
            accept=".opml,.xml,text/xml,application/xml"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importOpml(file);
            }}
          />
        </label>
        <a className="text-button" href="/api/social/opml" download>
          <Download size={16} />
          Export OPML
        </a>
      </div>
    </section>
  );
}

/** A story card that can be swiped left to remove it from Social. */
function SwipeAway({
  onRemove,
  children,
}: {
  onRemove: () => void;
  children: ReactNode;
}) {
  const swipe = useSwipe({ onLeft: onRemove });
  return (
    <div
      className={
        "card-swipe story-swipe" +
        (swipe.armed ? " armed-" + swipe.armed : "") +
        (swipe.offset ? " swiping" : "")
      }
      {...swipe.handlers}
    >
      <span className="swipe-under right" aria-hidden="true">
        <X size={20} /> Remove
      </span>
      <div
        className="story-swipe-card"
        style={
          swipe.offset
            ? { transform: `translateX(${swipe.offset}px)` }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}

/** The feeds Social can show, each added or removed with one button. */
function FeedCatalog({
  added,
  own,
  busy,
  onToggle,
  onRemoveOwn,
  onAdded,
}: {
  added: string[];
  own: FeedEntry[];
  busy: string;
  onToggle: (feed: FeedEntry) => void;
  onRemoveOwn: (feed: FeedEntry) => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const categories = [
    "All",
    ...new Set([...own.map((feed) => feed.category), ...catalogCategories]),
  ];
  const words = query.trim().toLowerCase();
  const entries = [...own, ...feedCatalog].filter(
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
      <AddByUrl onAdded={onAdded} />
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
          const mine = own.some((entry) => entry.id === feed.id);
          const isAdded = mine || added.includes(feed.id);
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
                  {mine ? "Yours" : isAdded ? "Added" : feed.category}
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
                  onClick={() => (mine ? onRemoveOwn(feed) : onToggle(feed))}
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

type Shown = SocialResponse & {
  added: string[];
  own: FeedEntry[];
  images: boolean;
  mutes: string[];
};

export type FeedDigest = {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  feeds: string | null;
  minute_of_day: number;
  zone: string;
  unread_only: number;
  enabled: number;
  last_run_at: number | null;
  last_error: string | null;
};

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
    minute % 60,
  ).padStart(2, "0")}`;

export type FeedWatch = {
  id: string;
  query: string;
  feeds: string | null;
  enabled: number;
  matches: number;
  last_match_at: number | null;
};

/** Words to keep out of Social, and whether feed pictures load at all. */
function HideSheet({
  mutes,
  images,
  onChanged,
  onClose,
}: {
  mutes: string[];
  images: boolean;
  onChanged: (next: { mutes?: string[]; images?: boolean }) => void;
  onClose: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState("");
  async function change(path: string, body: unknown, method: string) {
    try {
      const next = await api<{ mutes: string[] }>(path, body, method);
      onChanged(next);
      setPhrase("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Sheet title="Hide" onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <label>
        Hide stories containing
        <span className="add-feed-row">
          <input
            type="search"
            placeholder='crypto, or "live blog"'
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" &&
              void change("/social/mutes", { phrase }, "POST")
            }
          />
          <button
            type="button"
            className="secondary"
            disabled={!phrase.trim()}
            onClick={() => void change("/social/mutes", { phrase }, "POST")}
          >
            Hide
          </button>
        </span>
      </label>
      <div className="chip-row">
        {mutes.map((word) => (
          <button
            key={word}
            type="button"
            className="chip"
            aria-label={`Stop hiding ${word}`}
            onClick={() =>
              void change("/social/mutes", { phrase: word }, "DELETE")
            }
          >
            {word} ✕
          </button>
        ))}
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={images}
          onChange={async (e) => {
            const on = e.target.checked;
            onChanged({ images: on });
            try {
              await api("/social/preferences", { images: on }, "PUT");
            } catch (err) {
              onChanged({ images: !on });
              setError((err as Error).message);
            }
          }}
        />
        <span>
          Show pictures from feeds
          <small>
            A picture is loaded from the publisher, so it tells that site you
            opened Social. Off by default.
          </small>
        </span>
      </label>
    </Sheet>
  );
}

/**
 * Words and phrases followed across your feeds: when one matches a story that
 * arrives, your phone says so once. The preview shows what a watch would have
 * caught, so it can be judged before it is made.
 */
function WatchSheet({ onClose }: { onClose: () => void }) {
  const [watches, setWatches] = useState<FeedWatch[]>([]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<
    { feed: string; title: string; url: string }[] | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    try {
      const { watches: list } = await api<{ watches: FeedWatch[] }>(
        "/social/watches",
      );
      setWatches(list);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function show() {
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { stories } = await api<{
        stories: { feed: string; title: string; url: string }[];
      }>("/social/watches/preview", { query }, "POST");
      setPreview(stories);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      await api("/social/watches", { query }, "POST");
      setQuery("");
      setPreview(null);
      await load();
      notify({ text: "Following that." });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function change(watch: FeedWatch, body: Record<string, unknown>) {
    try {
      await api(
        `/social/watches/${watch.id}`,
        { query: watch.query, enabled: !!watch.enabled, ...body },
        "PATCH",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Sheet title="Follow a word" onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {watches.map((watch) => (
        <p key={watch.id} className="digest-row">
          <strong>{watch.query}</strong>
          <small>
            {plural(watch.matches, "match")}
            {watch.last_match_at
              ? ` · last ${relativeTime(watch.last_match_at)}`
              : ""}
          </small>
          <span className="actions">
            <button
              type="button"
              className="text-button"
              onClick={() => void change(watch, { enabled: !watch.enabled })}
            >
              {watch.enabled ? "Pause" : "Resume"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={async () => {
                await api(`/social/watches/${watch.id}`, undefined, "DELETE");
                await load();
              }}
            >
              Remove
            </button>
          </span>
        </p>
      ))}
      <label>
        Word or phrase
        <span className="add-feed-row">
          <input
            type="search"
            placeholder={'claude code, or "machine learning"'}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPreview(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void show()}
          />
          <button
            type="button"
            className="secondary"
            disabled={busy || !query.trim()}
            onClick={() => void show()}
          >
            Preview
          </button>
        </span>
      </label>
      <p className="field-hint">
        Words match whole words, so “ai” doesn’t find “said”. Several words mean
        all of them; use quotes for a phrase. Your phone is told once per story,
        at most three an hour.
      </p>
      {preview && (
        <>
          <p className="field-hint" role="status">
            {preview.length
              ? `Would have caught ${plural(preview.length, "story")}:`
              : "Nothing stored right now matches that."}
          </p>
          <ul className="watch-preview">
            {preview.map((story) => (
              <li key={story.url}>
                <strong>{story.title}</strong>
                <small>{story.feed}</small>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void create()}
            >
              Follow “{query.trim()}”
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/**
 * A digest Loop sends once a day: it collects what arrived and asks an agent
 * to summarize it. Also where agents are allowed to read the feed at all,
 * which is off until it is turned on here.
 */
function DigestSheet({
  feeds,
  agents,
  onClose,
}: {
  feeds: FeedEntry[];
  agents: { id: string; name: string; retired_at?: number | null }[];
  onClose: () => void;
}) {
  const [digests, setDigests] = useState<FeedDigest[]>([]);
  const [access, setAccess] = useState(false);
  const [agent, setAgent] = useState("");
  const [time, setTime] = useState("08:00");
  const [chosen, setChosen] = useState<string[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = agents.filter((a) => !a.retired_at);
  async function load() {
    try {
      const [list, preferences] = await Promise.all([
        api<{ digests: FeedDigest[] }>("/social/digests"),
        api<{ agent_access: boolean }>("/social/preferences"),
      ]);
      setDigests(list.digests);
      setAccess(preferences.agent_access);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function create() {
    const [hours, minutes] = time.split(":").map(Number);
    setBusy(true);
    setError("");
    try {
      await api(
        "/social/digests",
        {
          agentId: agent,
          minuteOfDay: hours * 60 + minutes,
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          feeds: chosen.length ? chosen : null,
          unreadOnly,
        },
        "POST",
      );
      setChosen([]);
      await load();
      notify({ text: "Digest scheduled." });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function change(digest: FeedDigest, body: Record<string, unknown>) {
    try {
      await api(
        `/social/digests/${digest.id}`,
        {
          agentId: digest.agent_id,
          conversationId: digest.conversation_id,
          feeds: digest.feeds ? JSON.parse(digest.feeds) : null,
          minuteOfDay: digest.minute_of_day,
          zone: digest.zone,
          unreadOnly: !!digest.unread_only,
          enabled: !!digest.enabled,
          ...body,
        },
        "PATCH",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(digest: FeedDigest) {
    try {
      await api(`/social/digests/${digest.id}`, undefined, "DELETE");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Sheet title="Digest" onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={access}
          onChange={async (e) => {
            const allowed = e.target.checked;
            setAccess(allowed);
            try {
              await api(
                "/social/preferences",
                { agent_access: allowed },
                "PUT",
              );
            } catch (err) {
              setAccess(!allowed);
              setError((err as Error).message);
            }
          }}
        />
        <span>
          Let agents read your feeds
          <small>
            An agent you ask can then read the feeds you follow. Off by default.
            A digest works either way.
          </small>
        </span>
      </label>
      {digests.map((digest) => (
        <p key={digest.id} className="digest-row">
          <strong>
            {clock(digest.minute_of_day)} ·{" "}
            {choices.find((a) => a.id === digest.agent_id)?.name || "an agent"}
          </strong>
          <small>
            {digest.feeds
              ? plural(JSON.parse(digest.feeds).length, "feed")
              : "All feeds"}
            {digest.unread_only ? " · unread only" : ""}
            {digest.last_error ? ` · ${digest.last_error}` : ""}
          </small>
          <span className="actions">
            <button
              type="button"
              className="text-button"
              onClick={() => void change(digest, { enabled: !digest.enabled })}
            >
              {digest.enabled ? "Pause" : "Resume"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => void remove(digest)}
            >
              Remove
            </button>
          </span>
        </p>
      ))}
      {!choices.length ? (
        <p className="field-hint">Create an agent first to send a digest to.</p>
      ) : (
        <>
          <label>
            Agent
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">Choose an agent</option>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Time
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            <span>Only what you haven’t read</span>
          </label>
          <fieldset className="digest-feeds">
            <legend>
              Feeds · {chosen.length ? plural(chosen.length, "feed") : "all"}
            </legend>
            {feeds.map((feed) => (
              <label key={feed.id} className="check-row">
                <input
                  type="checkbox"
                  checked={chosen.includes(feed.id)}
                  onChange={(e) =>
                    setChosen((old) =>
                      e.target.checked
                        ? [...old, feed.id]
                        : old.filter((id) => id !== feed.id),
                    )
                  }
                />
                <span>{feed.name}</span>
              </label>
            ))}
          </fieldset>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !agent}
              onClick={() => void create()}
            >
              {busy ? "Saving…" : "Schedule digest"}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/**
 * Social: stories from every feed you added, newest first, as Feed cards.
 * Links open the item or its discussion on the source; "Ask an agent" starts
 * a message about it. With no feeds yet it shows the catalog to pick from.
 */
export function Social({
  onAsk,
  agents = [],
}: {
  onAsk?: (text: string) => void;
  agents?: { id: string; name: string; retired_at?: number | null }[];
}) {
  const KEY = "social";
  const cached = cachedView<Shown>(KEY);
  const [view, setView] = useState<Shown | null>(cached || null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [choosing, setChoosing] = useState(false);
  const headerId = useId();
  // Feed options start closed on every visit; closed, Social is the stories
  // alone, without the page heading and agents above them.
  const [headerHidden, setHeaderHidden] = useState(true);
  // Toggling the header also hides or shows the page heading and agents above
  // it. Keep the toggle where it was tapped so the stories don't jump; Safari
  // has no scroll anchoring to do this for us.
  const headerToggle = useRef<HTMLButtonElement>(null);
  const toggleTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const before = toggleTop.current;
    toggleTop.current = null;
    if (before === null || !headerToggle.current) return;
    window.scrollBy(0, headerToggle.current.getBoundingClientRect().top - before);
  }, [headerHidden]);
  // The story being saved for later, if its sheet is open.
  const [saving, setSaving] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [digesting, setDigesting] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<SocialStory[] | null>(null);
  const [searchRevision, setSearchRevision] = useState(0);
  const [chosenCategory, setChosenCategory] = useState("All");
  const [chosenFeed, setChosenFeed] = useState("");
  const [showMuted, setShowMuted] = useState(false);
  const [muting, setMuting] = useState("");
  const muted = useRef(false);
  const [watching, setWatching] = useState(false);
  // A notification about a story opens Social on it.
  const [focused, setFocused] = useState(openedStory);
  const scrollToFocused = useCallback((node: HTMLElement | null) => node?.scrollIntoView({ block: "center" }), []);
  // Read by load(), which is not re-created when the filter changes.
  const unread = useRef(false);
  // Picking first feeds from the empty Social keeps the catalog open until Done.
  const [picking, setPicking] = useState(false);
  const request = useRef(0);
  const fillIn = useRef<ReturnType<typeof setTimeout>>(undefined);
  async function load(options: { force?: boolean; polls?: number } = {}) {
    const only =
      (unread.current ? "&unread=1" : "") + (muted.current ? "&muted=1" : "");
    const ticket = ++request.current;
    const owner = viewOwner();
    clearTimeout(fillIn.current);
    try {
      const [{ added, own }, social, preferences] = await Promise.all([
        api<{ added: string[]; own: FeedEntry[] }>("/social/feeds"),
        api<SocialResponse>(`/social?refresh=${options.force ? 1 : 0}${only}`),
        api<{ images: boolean; mutes: string[] }>("/social/preferences"),
      ]);
      if (ticket !== request.current || owner !== viewOwner()) return;
      const next = { ...social, added, own, ...preferences };
      setView(next);
      cacheView<Shown>(KEY, next, owner);
      setError("");
      // Feeds still loading arrive behind the first paint: ask again for them
      // a few times, then leave it to the five-minute refresh.
      const polls = options.polls ?? 0;
      if (social.pending.length && polls < FILL_IN_POLLS)
        fillIn.current = setTimeout(
          () => void load({ polls: polls + 1 }),
          FILL_IN_MS,
        );
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    }
  }
  /** Marks stories read (or unread) at once, before the server confirms. */
  async function setRead(ids: string[], read: boolean) {
    if (!ids.length) return;
    setFound(old => old?.map(story => ids.includes(story.id) ? { ...story, read } : story) ?? null);
    setView(
      (old) =>
        old && {
          ...old,
          stories: old.stories.map((story) =>
            ids.includes(story.id) ? { ...story, read } : story,
          ),
        },
    );
    try {
      const { unread } = await api<{ unread: number }>(
        "/social/read",
        { stories: ids },
        read ? "POST" : "DELETE",
      );
      setView((old) => old && { ...old, unread });
      // The Social chip's count lives in the Feed's summary.
      setSearchRevision(revision => revision + 1);
      window.dispatchEvent(new Event("loop-social-read"));
    } catch (e) {
      setError((e as Error).message);
      void load();
      setSearchRevision(revision => revision + 1);
    }
  }
  /** Takes stories out of Social at once, before the server confirms. */
  async function dismiss(ids: string[], removed: boolean) {
    if (removed) {
      setFound((old) => old?.filter((story) => !ids.includes(story.id)) ?? null);
      setView(
        (old) =>
          old && {
            ...old,
            stories: old.stories.filter((story) => !ids.includes(story.id)),
          },
      );
    }
    try {
      const { unread } = await api<{ unread: number }>(
        "/social/dismiss",
        { stories: ids },
        removed ? "POST" : "DELETE",
      );
      setView((old) => old && { ...old, unread });
      if (!removed) void load();
      setSearchRevision((revision) => revision + 1);
      window.dispatchEvent(new Event("loop-social-read"));
      if (removed)
        notify({
          text: "Removed from Social",
          undo: () => dismiss(ids, false),
        });
    } catch (e) {
      setError((e as Error).message);
      void load();
      setSearchRevision((revision) => revision + 1);
    }
  }
  async function readEverything() {
    try {
      const { unread } = await api<{ unread: number }>(
        "/social/read-all",
        {},
        "POST",
      );
      setFound(old => old?.map(story => ({ ...story, read: true })) ?? null);
      setView(
        (old) =>
          old && {
            ...old,
            unread,
            stories: old.stories.map((story) => ({ ...story, read: true })),
          },
      );
      setSearchRevision(revision => revision + 1);
      window.dispatchEvent(new Event("loop-social-read"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!query.trim()) { setFound(null); return; }
    const controller = new AbortController();
    const owner = viewOwner();
    const timer = setTimeout(() => {
      void api<SocialResponse>(
        `/social/search?q=${encodeURIComponent(query)}${
          chosenFeed ? `&feed=${encodeURIComponent(chosenFeed)}` : ""
        }${unreadOnly ? "&unread=1" : ""}`, undefined, undefined, controller.signal,
      ).then(({ stories }) => {
        if (!controller.signal.aborted && owner === viewOwner()) setFound(stories);
      }).catch(error => {
        if (!controller.signal.aborted && owner === viewOwner()) setError(error.message);
      });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, chosenFeed, unreadOnly, searchRevision]);
  async function removeOwn(feed: FeedEntry) {
    setBusy(feed.id);
    try {
      const { own } = await api<{ own: FeedEntry[] }>(
        `/social/sources/${feed.id}`,
        undefined,
        "DELETE",
      );
      setView((old) => old && { ...old, own });
      void load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
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
      if (adding && !view?.added.length && !view?.own.length) setPicking(true);
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
    // Pulling down the page asks the feeds themselves for anything new. A
    // notification arriving while Social is open also lands here, with the
    // story it was about now in the address.
    const pulled = () => {
      setFocused(openedStory());
      void load({ force: true });
    };
    window.addEventListener("loop-refresh", pulled);
    return () => {
      clearInterval(timer);
      clearTimeout(fillIn.current);
      window.removeEventListener("loop-refresh", pulled);
      // A load in flight must not write to an unmounted view.
      request.current++;
    };
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
    <FeedCatalog
      added={view.added}
      own={view.own}
      busy={busy}
      onToggle={toggle}
      onRemoveOwn={(feed) => void removeOwn(feed)}
      onAdded={() => void load()}
    />
  );
  const followed = view.added.length + view.own.length;
  if (!followed || picking)
    return (
      <>
        {errorBox}
        <div className="social-intro">
          <div>
            <p>
              <strong>Add feeds to Social.</strong>
            </p>
            <p className="field-hint">
              Pick sites and communities to follow. Their newest posts show here
              as cards, newest first.
            </p>
          </div>
          {!!followed && (
            <button
              type="button"
              className="primary"
              onClick={() => setPicking(false)}
            >
              Done · {plural(followed, "feed")}
            </button>
          )}
        </div>
        {catalog}
      </>
    );
  // Catalog feeds and the ones this owner added, as one lookup.
  const known = new Map<string, FeedEntry>([
    ...feedCatalog.map((feed) => [feed.id, feed] as const),
    ...view.own.map((feed) => [feed.id, feed] as const),
  ]);
  const health = new Map(view.feeds.map((feed) => [feed.id, feed]));
  const followedFeeds = [
    ...view.added.map((id) => known.get(id)!),
    ...view.own,
  ].filter(Boolean);
  const chipCategories = [
    "All",
    ...new Set(followedFeeds.map((feed) => feed.category)),
  ];
  // What is on the page: a search reaches the whole store, the chips narrow
  // what the feeds themselves sent.
  const onPage = (found ?? view.stories).filter((story) => {
    if (chosenFeed) return story.feed === chosenFeed;
    if (chosenCategory === "All") return true;
    return known.get(story.feed)?.category === chosenCategory;
  });
  const filtered = !!(
    query ||
    chosenFeed ||
    chosenCategory !== "All" ||
    unreadOnly
  );
  // A feed that could not be read says when it was last read, so a quiet feed
  // is distinguishable from a broken one.
  const failed = view.failed.map((id) => {
    const name = known.get(id)?.name || id;
    const read = health.get(id)?.fetched_at;
    return read ? `${name} (last read ${relativeTime(read)})` : name;
  });
  return (
    <>
      <section className="social-options" aria-label="Feed options">
        <button
          type="button"
          ref={headerToggle}
          className="social-options-toggle"
          aria-expanded={!headerHidden}
          aria-controls={headerId}
          onClick={(event) => {
            toggleTop.current = event.currentTarget.getBoundingClientRect().top;
            setHeaderHidden(!headerHidden);
          }}
        >
          <SlidersHorizontal size={18} aria-hidden="true" />
          <span className="social-options-label">
            <strong>Feed options</strong>
            <span className="field-hint">
              {filtered
                ? `Filtered · ${plural(onPage.length, "story")} shown`
                : `${plural(followed, "feed")}${
                    view.unread
                      ? ` · ${view.unread}${view.unread > 98 ? "+" : ""} unread`
                      : ""
                  }`}
            </span>
          </span>
          <ChevronDown size={18} aria-hidden="true" className="social-options-chevron" />
        </button>
        <div id={headerId} className="social-controls" hidden={headerHidden}>
          <div className="search-box social-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search your feeds"
              placeholder="Search your feeds"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {chipCategories.length > 2 && (
            <div className="chip-row" role="group" aria-label="Category">
              {chipCategories.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="chip"
                  aria-pressed={!chosenFeed && chosenCategory === value}
                  onClick={() => {
                    setChosenCategory(value);
                    setChosenFeed("");
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
          <div className="social-filters">
            <button
              type="button"
              className="chip"
              aria-pressed={unreadOnly}
              onClick={() => {
                unread.current = !unreadOnly;
                setUnreadOnly(!unreadOnly);
                void load();
              }}
            >
              Unread
            </button>
            <span className="social-filters-divider" aria-hidden="true" />
            <div className="chip-row" role="group" aria-label="Feed">
              {followedFeeds
                .filter(
                  (feed) =>
                    chosenCategory === "All" || feed.category === chosenCategory,
                )
                .map((feed) => (
                  <button
                    key={feed.id}
                    type="button"
                    className="chip"
                    aria-pressed={chosenFeed === feed.id}
                    onClick={() =>
                      setChosenFeed(chosenFeed === feed.id ? "" : feed.id)
                    }
                  >
                    {feed.name}
                  </button>
                ))}
            </div>
          </div>
          <div className="social-actions">
            {!!view.unread && (
              <button
                type="button"
                className="secondary"
                onClick={() => void readEverything()}
              >
                <CheckCheck size={16} aria-hidden="true" />
                Mark all read
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => setWatching(true)}
            >
              <Bell size={16} aria-hidden="true" />
              Follow a word
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setDigesting(true)}
            >
              <Sparkles size={16} aria-hidden="true" />
              Digest
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setChoosing(true)}
            >
              <Plus size={16} aria-hidden="true" />
              Add feeds
            </button>
          </div>
        </div>
      </section>
      {!!view.hidden && !showMuted && (
        <p className="field-hint" role="status">
          {plural(view.hidden, "story")} hidden by a word you muted.
          <button
            className="text-button"
            onClick={() => {
              muted.current = true;
              setShowMuted(true);
              void load();
            }}
          >
            Show
          </button>
        </p>
      )}
      {choosing && (
        <Sheet title="Add feeds" wide onClose={() => setChoosing(false)}>
          {catalog}
        </Sheet>
      )}
      {!!muting && (
        <HideSheet
          mutes={view.mutes}
          images={view.images}
          onChanged={(next) => {
            setView((old) => old && { ...old, ...next });
            if (next.mutes) void load();
          }}
          onClose={() => setMuting("")}
        />
      )}
      {watching && <WatchSheet onClose={() => setWatching(false)} />}
      {digesting && (
        <DigestSheet
          feeds={[
            ...view.added.map((id) => known.get(id)!),
            ...view.own,
          ].filter(Boolean)}
          agents={agents}
          onClose={() => setDigesting(false)}
        />
      )}
      {!!saving && (
        <LaterSheet
          kind="story"
          targetId={saving}
          title={
            (found ?? view.stories).find((story) => story.id === saving)?.title || "Story"
          }
          // Feeds belong to the paired app, never to a linked source.
          sourceId=""
          onClose={() => setSaving("")}
          onDone={(label, created) =>
            notify({
              text: `Saved · ${label}`,
              undo: () => undoReminder(created, ""),
            })
          }
        />
      )}
      {errorBox}
      {failed.length === 1 && (
        <p className="field-hint" role="status">
          Couldn’t load {failed[0]}. Trying again shortly.
        </p>
      )}
      {failed.length > 1 && (
        <details className="field-hint feed-trouble">
          <summary role="status">
            Couldn’t load {plural(failed.length, "feed")}. Trying again shortly.
          </summary>
          <ul>
            {failed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
      {!!focused && !view.stories.some((story) => story.id === focused) && (
        <p className="field-hint" role="status">
          That story is no longer in your feeds.
          <button
            className="text-button"
            onClick={() => forgetStory(setFocused)}
          >
            Dismiss
          </button>
        </p>
      )}
      {!!view.pending.length && (
        <p className="field-hint" role="status">
          Loading {plural(view.pending.length, "more feed")}…
        </p>
      )}
      {onPage.length ? (
        <ul className="inbox-list feed news-list" aria-label="Social">
          {onPage.map((story) => {
            const feed = known.get(story.feed);
            if (!feed) return null;
            return (
              <li key={story.id}>
                <SwipeAway onRemove={() => void dismiss([story.id], true)}>
                <article
                  className="feed-card news-card"
                  data-unread={story.read ? undefined : "true"}
                  data-focused={story.id === focused ? "true" : undefined}
                  data-story={story.id}
                  ref={
                    story.id === focused
                      ? scrollToFocused
                      : undefined
                  }
                >
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
                    {view.images && story.image && (
                      <img
                        className="news-image"
                        // Through Loop, not from the publisher: the page's own
                        // policy allows no third-party images, and a feed's
                        // picture should not tell its site who is reading.
                        src={`/api/social/image?story=${encodeURIComponent(
                          story.id,
                        )}`}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    )}
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
                        onClick={() => void setRead([story.id], true)}
                      >
                        {story.title}
                      </a>
                    </h2>
                    {story.summary && (
                      <p className="news-summary">{story.summary}</p>
                    )}
                    {story.media && (
                      <p className="field-hint news-media">
                        {story.media.type.startsWith("audio/")
                          ? "Audio"
                          : "Video"}
                        {story.media.seconds
                          ? ` · ${Math.round(story.media.seconds / 60)} min`
                          : ""}
                      </p>
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
                      onClick={() => void setRead([story.id], true)}
                    >
                      <ArrowUpRight size={16} />
                      Open
                    </a>
                    {story.comments_url && (
                      <a
                        href={story.comments_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => void setRead([story.id], true)}
                      >
                        <MessageSquare size={16} />
                        Discussion
                      </a>
                    )}
                    <button
                      onClick={() => void setRead([story.id], !story.read)}
                      aria-label={
                        story.read
                          ? `Mark ${story.title} unread`
                          : `Mark ${story.title} read`
                      }
                    >
                      <Check size={16} />
                      {story.read ? "Unread" : "Read"}
                    </button>
                    <button
                      onClick={() => setSaving(story.id)}
                      aria-label={`Save ${story.title} for later`}
                    >
                      <Bookmark size={16} />
                      Save
                    </button>
                    <button
                      onClick={() => setMuting(feed.id)}
                      aria-label={`Hide words or ${feed.name}`}
                    >
                      <EyeOff size={16} />
                      Hide
                    </button>
                    {onAsk && (
                      <button
                        onClick={() => {
                          void setRead([story.id], true);
                          onAsk(
                            `About this ${feed.name} ${feed.kind}: ${story.title}\n${story.url}` +
                              (story.comments_url &&
                              story.comments_url !== story.url
                                ? `\nDiscussion: ${story.comments_url}`
                                : "") +
                              "\n\n",
                          );
                        }}
                      >
                        <MessageSquarePlus size={16} />
                        Ask an agent
                      </button>
                    )}
                  </div>
                </article>
                </SwipeAway>
              </li>
            );
          })}
        </ul>
      ) : view.pending.length ? (
        <div className="feed-loading" role="status" aria-label="Loading Social">
          <span />
          <span />
          <span />
        </div>
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
