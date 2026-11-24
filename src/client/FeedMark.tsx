import type { FeedEntry } from "../shared/news";

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

export type FeedMarkSource = Pick<
  FeedEntry,
  "name" | "color" | "home" | "mark"
>;

/**
 * A feed's mark: the site's own where it has one, else its initial on its
 * colour. A catalog entry names its mark; a feed someone added by address is
 * recognised by its host.
 */
export function FeedMark({ feed }: { feed: FeedMarkSource }) {
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
