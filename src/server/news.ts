import * as feedSourcesQueries from "./sql/feed-sources.js";
import * as feedSearchQueries from "./sql/feed-search.js";
import * as feedStateQueries from "./sql/feed-state.js";
import * as feedStoriesQueries from "./sql/feed-stories.js";
import * as feedReadsQueries from "./sql/feed-reads.js";
import * as feedDismissalsQueries from "./sql/feed-dismissals.js";
import * as feedWatchHitsQueries from "./sql/feed-watch-hits.js";
import * as feedMutesQueries from "./sql/feed-mutes.js";
import * as feedPreferencesQueries from "./sql/feed-preferences.js";
import * as feedSubscriptionsQueries from "./sql/feed-subscriptions.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { registrar } from "./registrar.js";

import { db, now, emit } from "./db.js";
import { Problem } from "./domain.js";

import { download, imageBytes, withFeedFetch } from "./feed-fetch.js";
import {
  addSource,
  discover,
  exportOpml,
  importOpml,
  ownSource,
  ownSources,
  removeSource,
} from "./feed-sources.js";
import {
  feedById,
  matchesWatch,
  sameStoryUrl,
  watchTerms,
  type FeedEntry,
  type NewsStory,
  type SocialResponse,
  type SocialStory,
} from "../shared/news.js";

// Social shows the public feeds an owner follows: catalog entries from
// src/shared/news.ts, and addresses they added themselves (feed-sources.ts).
// The feeds hold no account data, so one stored copy per feed serves every
// owner, while which feeds you follow, what you have read and what you saved
// are yours alone.
//
// Stories are shown to you. An agent can read them only through loop_feed,
// and only once you have turned agent access on — it is off by default,
// because a tool that lists your feed puts what you follow into a model's
// context. Nothing else here reaches an agent.

const FRESH_MS = 5 * 60_000;
// A feed that failed is retried after this at the earliest, doubling while it
// keeps failing, so a feed that has gone for good is not asked for every two
// minutes for as long as someone has it added.
const RETRY_MS = 2 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
// How long a feed's own Retry-After may hold off the next attempt.
const MAX_RETRY_AFTER_MS = 6 * 60 * 60_000;
// Each feed's newest stories, so one busy feed doesn't bury the others.
const PER_FEED = 20;
const MAX_STORIES = 400;
// A deliberate refresh ignores the five-minute copy, but not more often than
// this: pulling down repeatedly must not become a way to hammer a feed.
const MIN_REFRESH_MS = 30_000;
// Feeds read at once. Enough to fill a page quickly, few enough that twenty
// added feeds are not twenty simultaneous requests from one address.
const CONCURRENT_FEEDS = 4;
// How long a feed with nothing stored yet has to answer before the page is
// sent without it. Feeds that answer quickly still make the first paint.
const FIRST_PAINT_MS = 500;
// Stories kept per feed. Enough for reading back a few days of a busy feed,
// bounded so the store does not grow with every refresh.
const KEEP_PER_FEED = 120;
// Stories of a feed nobody follows any more are dropped after this.
const ABANDONED_MS = 30 * 24 * 60 * 60_000;
// Feeds refreshed per worker pass, and how many of those run at once.
const PER_PASS = 8;
/** Words one owner may hide. */
const MAX_MUTES = 100;

/** A stored story carries when Loop first read it, which the list sorts by. */
type StoredStory = NewsStory & { first_seen_at: number };
type Shown = { stories: StoredStory[]; fetched_at: number };
type Failure = {
  error: unknown;
  failed_at: number;
  retry_at: number;
  failures: number;
};
/** Raised for a feed that is still loading, to tell it apart from a failure. */
class Pending extends Error {}
/** Rejects with Pending once a feed has had its moment to answer. */
const pendingAfter = (ms: number) =>
  new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Pending()), ms);
    // A request must not hold the process open waiting to give up on a feed.
    timer.unref?.();
  });
// The stories a feed last gave, read back from feed_stories once and kept
// until the feed is refreshed: a twenty-feed page should not decode the same
// JSON twenty times a minute.
const hot = new Map<string, Shown>();
const pending = new Map<string, Promise<Shown>>();
// Only owners reading a refresh in progress need its completion notification.
// Routine worker refresh timestamps still produce no workspace traffic.
const waitingReaders = new Map<string, Set<string>>();

/** Tests swap the network for a fixture; returns a restore function. */
export function withNewsFixture(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
) {
  const restore = withFeedFetch(fetcher);
  const clear = () => {
    forgetCachedStories();
    feedStoriesQueries.clear(db);
    feedStateQueries.clear(db);
  };
  clear();
  return () => {
    restore();
    clear();
  };
}

/**
 * Drops the read-through copies, so the next read comes from the database.
 * Each process keeps its own: a restart drops them, and a feed the worker
 * refreshed in another process is noticed by its fetch time changing.
 */
export function forgetCachedStories() {
  hot.clear();
}

type FeedState = {
  feed_id: string;
  fetched_at: number | null;
  failed_at: number | null;
  failures: number;
  error: string | null;
  retry_at: number | null;
  etag: string | null;
  last_modified: string | null;
  stories: number;
};

const feedState = (id: string) =>
  feedStateQueries.byFeed(db, id) as FeedState | undefined;

/** The stories a feed last gave, or null if it has never been read. */
function stored(id: string, state = feedState(id)): Shown | null {
  if (!state?.fetched_at) return null;
  const warm = hot.get(id);
  if (warm && warm.fetched_at === state.fetched_at) return warm;
  const rows = feedStoriesQueries.recent(db, id, KEEP_PER_FEED) as {
    story: string;
    first_seen_at: number;
  }[];
  const shown = {
    stories: rows.map((row) => ({
      ...(JSON.parse(row.story) as NewsStory),
      first_seen_at: row.first_seen_at,
    })),
    fetched_at: state.fetched_at,
  };
  hot.set(id, shown);
  return shown;
}

/**
 * Keeps what a feed gave: new stories are added with the time Loop first saw
 * them, stories it still lists are left as they were, and only the newest
 * KEEP_PER_FEED survive.
 */
const keep = db.transaction(
  (
    feed: FeedEntry,
    answer: {
      stories: NewsStory[];
      title: string | null;
      home: string | null;
      etag: string | null;
      last_modified: string | null;
    },
    at: number,
  ) => {
    for (const story of answer.stories)
      feedStoriesQueries.upsert(
        db,
        feed.id,
        story.id,
        story.url,
        story.title,
        story.summary,
        JSON.stringify(story),
        story.published_at,
        at,
        at,
      );
    feedStoriesQueries.prune(db, { feed: feed.id, keep: KEEP_PER_FEED });
    // A read mark or watch hit for a story that is gone can never be used.
    feedReadsQueries.pruneMissing(db, feed.id);
    feedDismissalsQueries.pruneMissing(db, feed.id);
    feedWatchHitsQueries.pruneMissing(db, feed.id);
    const count = feedStoriesQueries.count(db, feed.id) as { n: number };
    feedStateQueries.received(db, {
      feed: feed.id,
      title: answer.title,
      home: answer.home,
      at,
      etag: answer.etag,
      modified: answer.last_modified,
      stories: count.n,
    });
  },
);

/** Marks a feed as still good without having re-read it (a 304). */
function touch(id: string, at: number) {
  feedStateQueries.touch(db, at, id);
}

function recordFailure(feed: FeedEntry, error: unknown, at: number) {
  const failures = (feedState(feed.id)?.failures ?? 0) + 1;
  const wait = backoffMs(
    failures,
    (error as { retryAfterMs?: number | null })?.retryAfterMs ?? null,
  );
  feedStateQueries.failed(db, {
    feed: feed.id,
    at,
    failures,
    error: String((error as Error)?.message || error).slice(0, 300),
    retry: at + wait,
  });
}

/**
 * How long to leave a failing feed: two minutes doubling to an hour, or what
 * the feed itself asked for when that is longer.
 */
function backoffMs(failures: number, retryAfterMs: number | null) {
  const wait = Math.min(
    RETRY_MS * 2 ** Math.min(failures - 1, 5),
    MAX_RETRY_MS,
  );
  if (retryAfterMs === null) return wait;
  return Math.max(wait, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}

/** Runs each task, at most `limit` at a time, settling like allSettled. */
async function atMost<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
) {
  const results: PromiseSettledResult<R>[] = [];
  const queue = items.map((item, index) => ({ item, index }));
  const worker = async () => {
    for (let next; (next = queue.shift());)
      results[next.index] = await run(next.item).then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason) => ({ status: "rejected", reason }) as const,
      );
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Reads the feed and keeps what it gave, as one request at a time. */
function read(feed: FeedEntry, at: number, state?: FeedState) {
  let request = pending.get(feed.id);
  if (request) return request;
  request = download(feed, {
    etag: state?.etag,
    last_modified: state?.last_modified,
  })
    .then((answer) => {
      if (!answer.modified) {
        touch(feed.id, at);
        hot.delete(feed.id);
        return { stories: stored(feed.id)?.stories ?? [], fetched_at: at };
      }
      keep(feed, answer, at);
      hot.delete(feed.id);
      return stored(feed.id)!;
    })
    .catch((error) => {
      recordFailure(feed, error, at);
      throw error;
    })
    .finally(() => {
      pending.delete(feed.id);
      const readers = waitingReaders.get(feed.id);
      waitingReaders.delete(feed.id);
      for (const owner of readers ?? [])
        emit(owner, { kind: "collection", id: "social" }, "invalidate", {
          scope: { kind: "collection", id: "social" },
        });
    });
  pending.set(feed.id, request);
  return request;
}

/**
 * Fresh stories, refetched at most every five minutes by one request at a
 * time. A failure is remembered too, so a feed that keeps failing is retried
 * on a widening delay rather than on every load. `force` is a deliberate
 * refresh: it ignores both waits, down to a thirty-second floor.
 *
 * Both the stories and the failure are kept in the database, so a restart
 * still has something to show and does not start every feed over.
 */
export async function feedStories(
  feed: FeedEntry,
  at = Date.now(),
  options: { force?: boolean } = {},
): Promise<Shown> {
  const state = feedState(feed.id);
  const last = stored(feed.id, state);
  const due = options.force
    ? at - Math.max(state?.fetched_at ?? 0, state?.failed_at ?? 0) >=
      MIN_REFRESH_MS
    : (!last || at - last.fetched_at >= FRESH_MS) &&
      at >= (state?.retry_at ?? 0);
  if (!due) {
    if (last) return last;
    // Inside the backoff with nothing stored: report why it is quiet.
    if (state?.error) throw new Error(state.error);
  }
  try {
    return await read(feed, at, state);
  } catch (error) {
    // A stale list beats an error.
    if (last) return last;
    throw error;
  }
}

/** Feeds someone follows that are due to be read, oldest copy first. */
function dueFeeds(at: number, limit = PER_PASS) {
  return (
    feedSubscriptionsQueries.due(db, { stale: at - FRESH_MS, at, limit }) as {
      owner_id: string;
      feed_id: string;
    }[]
  )
    .map(
      (row) =>
        feedById.get(row.feed_id) || ownSource(row.owner_id, row.feed_id),
    )
    .filter((feed): feed is FeedEntry => !!feed);
}

let refreshing = false;
/**
 * Worker job: reads the feeds someone follows before anyone opens Social, so
 * a page is served from the store rather than from the network, and stays
 * fresh while nobody has the tab open. It also drops the stories of feeds
 * nobody follows any more.
 */
export async function refreshDueFeeds(at = Date.now()) {
  if (refreshing) return 0;
  refreshing = true;
  try {
    const feeds = dueFeeds(at);
    await atMost(feeds, CONCURRENT_FEEDS, (feed) =>
      read(feed, at, feedState(feed.id)).catch(() => {}),
    );
    forgetAbandoned(at);
    return feeds.length;
  } finally {
    refreshing = false;
  }
}

/** Stories of feeds nobody follows any more, a month after the last read. */
export function forgetAbandoned(at = Date.now()) {
  const gone = feedStateQueries.abandoned(db, at - ABANDONED_MS) as {
    feed_id: string;
  }[];
  for (const { feed_id } of gone)
    db.transaction(() => {
      feedReadsQueries.removeFeed(db, feed_id);
      feedDismissalsQueries.removeFeed(db, feed_id);
      feedWatchHitsQueries.removeFeed(db, feed_id);
      feedStoriesQueries.removeFeed(db, feed_id);
      feedStateQueries.removeFeed(db, feed_id);
      hot.delete(feed_id);
    })();
  return gone.length;
}

function catalogFeed(id: string) {
  const feed = feedById.get(id);
  if (!feed) throw new Problem(404, "No such feed.");
  return feed;
}

// One row per feed an owner follows, of either kind: from the catalog, or
// added by address.

/** Which of a feed's stories this owner has read, for the list it is building. */
function readMarks(owner: string) {
  const through = new Map(
    (
      feedSubscriptionsQueries.readThrough(db, owner) as {
        feed_id: string;
        read_through_at: number | null;
      }[]
    ).map((row) => [row.feed_id, row.read_through_at ?? 0]),
  );
  const marks = new Map(
    (
      feedReadsQueries.marks(db, owner) as {
        feed_id: string;
        story_id: string;
        is_read: number;
      }[]
    ).map((row) => [`${row.feed_id}:${row.story_id}`, !!row.is_read] as const),
  );
  return (feed: string, story: StoredStory) => {
    // Marking one story read or unread outlives a "mark all read".
    const marked = marks.get(`${feed}:${story.id}`);
    if (marked !== undefined) return marked;
    return (
      (story.published_at ?? story.first_seen_at) <= (through.get(feed) ?? 0)
    );
  };
}

/** Whether this owner swiped a story away, as "<feed>:<story>" lookups. */
function dismissals(owner: string) {
  const gone = new Set(
    (
      feedDismissalsQueries.marks(db, owner) as {
        feed_id: string;
        story_id: string;
      }[]
    ).map((row) => `${row.feed_id}:${row.story_id}`),
  );
  return (feed: string, story: { id: string }) =>
    gone.has(`${feed}:${story.id}`);
}

/** Unread stories across the feeds you added, as the Social chip's count. */
export function unreadCount(owner: string, cap = 99) {
  const wasRead = readMarks(owner);
  const wasDismissed = dismissals(owner);
  const hiding = mutes(owner).map(watchTerms);
  const unread = new Set<string>();
  const dismissed = new Set<string>();
  for (const feed of ownerFeeds(owner)) {
    for (const story of (stored(feed.id)?.stories ?? []).slice(0, PER_FEED)) {
      if (wasDismissed(feed.id, story)) {
        dismissed.add(sameStoryUrl(story.url));
        continue;
      }
      if (
        wasRead(feed.id, story) ||
        hiding.some((terms) => matchesWatch(terms, story))
      )
        continue;
      unread.add(sameStoryUrl(story.url));
    }
  }
  // The same article from another feed went with the one swiped away.
  for (const key of dismissed) unread.delete(key);
  return Math.min(unread.size, cap);
}

/**
 * The feed and story a client-held id names: "<feed>:<story>". Either half
 * can contain a colon — a feed someone added by address is "user:<hash>", and
 * a story id is whatever its feed chose — so the feed is matched against the
 * ones this owner follows, longest first, rather than split at a colon.
 */
function splitStoryId(owner: string, value: string) {
  const feed = ownerFeeds(owner)
    .map((entry) => entry.id)
    .filter((id) => value.startsWith(`${id}:`))
    .sort((a, b) => b.length - a.length)[0];
  if (!feed) throw new Problem(404, "No such story.");
  return { feed, story: value.slice(feed.length + 1) };
}

/** A stored story of a feed this owner follows, or 404. */
function ownedStory(owner: string, storyId: string) {
  const { feed, story } = splitStoryId(owner, storyId);
  const row = feedStoriesQueries.owned(db, owner, feed, story) as
    { story: string; first_seen_at: number } | undefined;
  if (!row) throw new Problem(404, "No such story.");
  return {
    feed,
    story: {
      ...(JSON.parse(row.story) as NewsStory),
      first_seen_at: row.first_seen_at,
    },
  };
}

/**
 * A story this owner can save: public feed content, so it is theirs to keep
 * only while they follow the feed it came from. Null rather than a 404, for
 * the Later list, which shows what it can and skips the rest.
 */
export function savedStory(owner: string, storyId: string) {
  try {
    return ownedStory(owner, storyId).story;
  } catch {
    return null;
  }
}

/** Marks stories read, or unread again. Unknown stories are ignored. */
export const markRead = db.transaction(
  (owner: string, stories: string[], read: boolean, at = now()) => {
    for (const value of stories) {
      let identity: ReturnType<typeof splitStoryId>;
      try {
        ownedStory(owner, value);
        identity = splitStoryId(owner, value);
      } catch (error) {
        if (error instanceof Problem && error.status === 404) continue;
        throw error;
      }
      const { feed, story } = identity;
      // Unread is recorded rather than deleted: a story the "mark all read"
      // watermark covers has no row to remove, and the mark has to stick.
      feedReadsQueries.mark(db, owner, feed, story, at, read ? 1 : 0);
    }
    return unreadCount(owner);
  },
).immediate;

/** Removes stories from Social, or brings them back. Unknown ones are ignored. */
export const dismissStories = db.transaction(
  (owner: string, stories: string[], dismissed: boolean, at = now()) => {
    for (const value of stories) {
      let identity: ReturnType<typeof splitStoryId>;
      try {
        ownedStory(owner, value);
        identity = splitStoryId(owner, value);
      } catch (error) {
        if (error instanceof Problem && error.status === 404) continue;
        throw error;
      }
      const { feed, story } = identity;
      if (dismissed) feedDismissalsQueries.insert(db, owner, feed, story, at);
      else feedDismissalsQueries.remove(db, owner, feed, story);
    }
    return unreadCount(owner);
  },
).immediate;

/** Marks everything a feed has listed so far read, or every feed's. */
export function markAllRead(owner: string, feed?: string, at = now()) {
  if (feed) ownerFeed(owner, feed);
  feedSubscriptionsQueries.markThrough(db, at, owner, feed);
  feedSourcesQueries.markThrough(db, at, owner, feed);
  feedReadsQueries.clearMarks(db, owner, feed);
  return unreadCount(owner);
}

/** Words this owner never wants to see in Social. */
export function mutes(owner: string) {
  return (feedMutesQueries.phrases(db, owner) as { phrase: string }[]).map(
    (row) => row.phrase,
  );
}

export function muteWords(owner: string, phrase: string) {
  const word = phrase.trim().slice(0, 80);
  if (!watchTerms(word).length)
    throw new Problem(400, "Enter a word or phrase to hide.");
  if (mutes(owner).length >= MAX_MUTES)
    throw new Problem(400, `You can hide ${MAX_MUTES} words.`);
  feedMutesQueries.insert(db, owner, word, now());
  return mutes(owner);
}

function unmuteWords(owner: string, phrase: string) {
  feedMutesQueries.remove(db, owner, phrase);
  return mutes(owner);
}

/**
 * Search the stories Loop has stored, across the feeds this owner follows.
 * Reaches further back than the page does, which is the point of it: a story
 * from last week is no longer in the list but is still in the store.
 */
export function searchStories(
  owner: string,
  ask: { q: string; feed?: string; unread?: boolean; limit?: number },
) {
  const query = ask.q.trim();
  if (!query) return { stories: [] };
  const mine = new Map(ownerFeeds(owner).map((feed) => [feed.id, feed]));
  const feeds = ask.feed ? [ownerFeed(owner, ask.feed).id] : [...mine.keys()];
  if (!feeds.length) return { stories: [] };
  const wasRead = readMarks(owner);
  const wasDismissed = dismissals(owner);
  const rows = feedSearchQueries.search(db, ftsQuery(query), feeds, 200) as {
    feed_id: string;
    story_id: string;
    story: string;
    first_seen_at: number;
  }[];
  const stories: SocialStory[] = [];
  for (const row of rows) {
    const story = {
      ...(JSON.parse(row.story) as NewsStory),
      first_seen_at: row.first_seen_at,
    };
    if (wasDismissed(row.feed_id, { id: row.story_id })) continue;
    const read = wasRead(row.feed_id, story);
    if (ask.unread && read) continue;
    stories.push({
      ...story,
      id: `${row.feed_id}:${row.story_id}`,
      feed: row.feed_id,
      read,
    });
    if (stories.length >= Math.min(ask.limit ?? 50, 100)) break;
  }
  return { stories };
}

/**
 * What someone typed, as an FTS5 query: each word a prefix term, a quoted
 * phrase kept as one. Written out rather than passed through, so no part of
 * the query language can be typed into the index by accident.
 */
function ftsQuery(query: string) {
  return (
    watchTerms(query)
      .map((term) => `"${term.replace(/"/g, "")}"${/\s/.test(term) ? "" : "*"}`)
      .join(" AND ") || '""'
  );
}

/** Whether agents this owner asks may read the feeds they follow. */
export function feedPreferences(owner: string) {
  const row = feedPreferencesQueries.owned(db, owner) as
    { agent_access: number; images: number } | undefined;
  return {
    agent_access: !!row?.agent_access,
    images: !!row?.images,
    mutes: mutes(owner),
  };
}

export const agentFeedAccess = (owner: string) =>
  feedPreferences(owner).agent_access;

export function setFeedPreferences(
  owner: string,
  change: { agent_access?: boolean; images?: boolean },
) {
  const current = feedPreferences(owner);
  feedPreferencesQueries.upsert(
    db,
    owner,
    (change.agent_access ?? current.agent_access) ? 1 : 0,
    (change.images ?? current.images) ? 1 : 0,
    now(),
  );
  return feedPreferences(owner);
}

/** Kept for callers that only turn agent access on or off. */
export const setAgentFeedAccess = (owner: string, allowed: boolean) =>
  setFeedPreferences(owner, { agent_access: allowed });

/**
 * Stories for an agent that was asked about the feed, or for a digest. Reads
 * the store only: it fetches nothing, marks nothing read, and never sees a
 * feed its owner does not follow.
 */
export function feedForAgent(
  owner: string,
  ask: {
    feedId?: string;
    query?: string;
    unreadOnly?: boolean;
    since?: number;
    /** Only stories Loop first read after this, which is what a digest covers. */
    arrivedSince?: number;
    limit?: number;
  } = {},
) {
  const feeds = ownerFeeds(owner).filter(
    (feed) => !ask.feedId || feed.id === ask.feedId,
  );
  if (ask.feedId && !feeds.length) throw new Problem(404, "No such feed.");
  const names = new Map(feeds.map((feed) => [feed.id, feed]));
  const wasRead = readMarks(owner);
  const words = ask.query?.trim().toLowerCase();
  const stories = feeds
    .flatMap((feed) =>
      (stored(feed.id)?.stories ?? [])
        .slice(0, PER_FEED)
        .map((story) => ({ feed, story, read: wasRead(feed.id, story) })),
    )
    .filter(
      ({ story, read }) =>
        (!ask.unreadOnly || !read) &&
        (!ask.since ||
          (story.published_at ?? story.first_seen_at) >= ask.since) &&
        (!ask.arrivedSince || story.first_seen_at > ask.arrivedSince) &&
        (!words ||
          `${story.title} ${story.summary ?? ""}`
            .toLowerCase()
            .includes(words)),
    )
    .sort(
      (a, b) =>
        (b.story.published_at ?? b.story.first_seen_at) -
        (a.story.published_at ?? a.story.first_seen_at),
    )
    .slice(0, Math.min(ask.limit ?? 20, 50));
  return {
    // What the agent can say "as of" about.
    read_at: Math.max(
      0,
      ...feeds.map((feed) => feedState(feed.id)?.fetched_at ?? 0),
    ),
    stories: stories.map(({ feed, story, read }) => ({
      feed: names.get(feed.id)!.name,
      title: story.title,
      url: story.url,
      comments_url: story.comments_url,
      site: story.site,
      author: story.author,
      published_at: story.published_at,
      points: story.points,
      comments: story.comments,
      summary: story.summary,
      read,
    })),
  };
}

/**
 * Stories of these feeds, newest first, that Loop first read after `since`.
 * For watches, which look at what has arrived rather than at the page.
 */
export function storiesForWatch(
  owner: string,
  feeds: string[],
  since: number,
  limit: number,
  /**
   * Which candidates count, applied before the limit. A watch uses it to skip
   * the ones it has already announced: narrowing afterwards would mean the
   * newest `limit` stories crowd out everything behind them for good.
   */
  keep?: (candidate: { feed_id: string; story: StoredStory }) => boolean,
) {
  const mine = new Map(ownerFeeds(owner).map((feed) => [feed.id, feed]));
  return feeds
    .filter((feed) => mine.has(feed))
    .flatMap((feed) =>
      (stored(feed)?.stories ?? [])
        .filter((story) => story.first_seen_at > since)
        .map((story) => ({ feed: mine.get(feed)!.name, feed_id: feed, story })),
    )
    .filter((candidate) => !keep || keep(candidate))
    .sort(
      (a, b) =>
        (b.story.published_at ?? b.story.first_seen_at) -
        (a.story.published_at ?? a.story.first_seen_at),
    )
    .slice(0, limit);
}

/** What each added feed last did, for the line that says why one is quiet. */
function feedHealth(owner: string) {
  return ownerFeeds(owner).map(({ id }) => {
    const state = feedState(id);
    return {
      id,
      fetched_at: state?.fetched_at ?? null,
      failed_at: state?.failed_at ?? null,
      error: state?.error ?? null,
      stories: state?.stories ?? 0,
    };
  });
}

export function addedFeeds(owner: string): string[] {
  return (feedSubscriptionsQueries.feeds(db, owner) as { feed_id: string }[])
    .map((row) => row.feed_id)
    .filter((id) => feedById.has(id));
}

/**
 * Every feed this owner follows: the catalog ones they added and the ones
 * they added by address. Everything downstream — the list, read marks, the
 * worker, saving — goes through here and stops caring which kind a feed is.
 */
export function ownerFeeds(owner: string): FeedEntry[] {
  return [
    ...addedFeeds(owner).map((id) => feedById.get(id)!),
    ...ownSources(owner),
  ];
}

/**
 * A feed this owner follows, catalog or their own, or 404. Being in the
 * catalog is not enough: a feed nobody added is not theirs to mark read, put
 * in a digest or watch.
 */
export function ownerFeed(owner: string, id: string) {
  const feed = ownerFeeds(owner).find((candidate) => candidate.id === id);
  if (!feed) throw new Problem(404, "No such feed.");
  return feed;
}

/**
 * What the same story from a second feed adds to the copy already kept: a
 * discussion to open, points, a byline. Hacker News carries the points and
 * The Verge carries the article, and whichever was added first should not
 * decide which of the two you see.
 */
function merge(kept: SocialStory, other: NewsStory) {
  for (const field of ["author", "points", "comments", "summary"] as const)
    if (kept[field] === null && other[field] !== null)
      (kept as Record<string, unknown>)[field] = other[field];
  if (!kept.comments_url && other.comments_url) {
    kept.comments_url = other.comments_url;
    kept.comments = kept.comments ?? other.comments;
  }
}

/**
 * Every added feed's newest stories in one list, newest first.
 *
 * A feed with a copy already read is returned straight away and refreshed
 * behind the response; a feed with nothing to show yet gets a moment to
 * answer and is otherwise reported in `pending` and left loading. So a page is
 * never held up by its slowest feed, and asking again shortly fills it in.
 */
export async function socialStories(
  owner: string,
  at = Date.now(),
  options: {
    force?: boolean;
    wait?: boolean;
    unread?: boolean;
    muted?: boolean;
  } = {},
): Promise<SocialResponse> {
  const feeds = ownerFeeds(owner);
  const wasRead = readMarks(owner);
  const wasDismissed = dismissals(owner);
  const hiding = mutes(owner).map(watchTerms);
  const matchesAnyMute = (story: StoredStory) =>
    hiding.some((terms) => matchesWatch(terms, story));
  let hidden = 0;
  const results = await atMost(feeds, CONCURRENT_FEEDS, (feed) => {
    const request = feedStories(feed, at, options);
    if (options.wait) return request;
    if (pending.has(feed.id)) {
      const readers = waitingReaders.get(feed.id) ?? new Set<string>();
      readers.add(owner);
      waitingReaders.set(feed.id, readers);
    }
    const last = stored(feed.id);
    if (!last) return Promise.race([request, pendingAfter(FIRST_PAINT_MS)]);
    // A copy is on hand: show it rather than wait for the refresh.
    void request.catch(() => {});
    return pending.has(feed.id)
      ? Promise.race([request, pendingAfter(FIRST_PAINT_MS)]).catch(() => last)
      : Promise.resolve(last);
  });
  const kept = new Map<string, SocialStory>();
  // Swiping a story away removes the same article from every feed.
  const dismissed = new Set<string>();
  const failed: string[] = [];
  const loading: string[] = [];
  let fetched_at = 0;
  results.forEach((result, index) => {
    const feed = feeds[index];
    if (result.status === "rejected")
      return void (result.reason instanceof Pending ? loading : failed).push(
        feed.id,
      );
    // Still being refreshed: ask again for what the refresh brings.
    if (pending.has(feed.id)) loading.push(feed.id);
    fetched_at = Math.max(fetched_at, result.value.fetched_at);
    for (const story of result.value.stories.slice(0, PER_FEED)) {
      const key = sameStoryUrl(story.url);
      if (wasDismissed(feed.id, story)) {
        dismissed.add(key);
        continue;
      }
      const already = kept.get(key);
      // The same article from two feeds is shown once, keeping what each knew.
      if (already) {
        merge(already, story);
        continue;
      }
      const read = wasRead(feed.id, story);
      if (read && options.unread) continue;
      if (!options.muted && matchesAnyMute(story)) {
        hidden++;
        continue;
      }
      kept.set(key, {
        ...story,
        id: `${feed.id}:${story.id}`,
        feed: feed.id,
        read,
      });
    }
  });
  // An undated story sorts by when Loop first read it, which for the feeds
  // that date nothing is the only order there is.
  for (const key of dismissed) kept.delete(key);
  const stories = [...kept.values()].sort(
    (a, b) =>
      (b.published_at ?? b.first_seen_at) - (a.published_at ?? a.first_seen_at),
  );
  return {
    stories: stories.slice(0, MAX_STORIES),
    failed,
    pending: loading,
    fetched_at,
    feeds: feedHealth(owner),
    unread: unreadCount(owner),
    hidden,
  };
}

const routes = registrar("news");
export const news = routes.mount;
routes.on(workspaceApi.socialUnread, (_req, res) => {
  res.json({ unread: unreadCount(res.locals.owner) });
});
routes.on(workspaceApi.socialList, async (req, res) => {
  res.json(
    await socialStories(res.locals.owner, Date.now(), {
      force: req.query.refresh === "1",
      // Loading feeds are reported rather than waited for, unless the caller
      // asked for the whole list at once.
      wait: req.query.wait === "1",
      unread: req.query.unread === "1",
      // Muted words are hidden unless you ask to see them.
      muted: req.query.muted === "1",
    }),
  );
});
routes.on(workspaceApi.socialSearch, (req, res) => {
  res.json(
    searchStories(res.locals.owner, {
      q: req.query.q,
      feed: req.query.feed,
      unread: req.query.unread === "1",
    }),
  );
});
/**
 * The picture a feed offered for a story, passed through Loop rather than
 * loaded by the browser: the page's own CSP stays `img-src 'self'`, and the
 * publisher never sees who is reading. Only the address stored on a story of
 * a feed this owner follows is ever fetched.
 */
routes.on(workspaceApi.socialImage, async (req, res) => {
  const { story } = ownedStory(res.locals.owner, req.query.story);
  if (!story.image) throw new Problem(404, "No picture there.");
  const { type, bytes } = await imageBytes(story.image);
  res
    .type(type)
    .set({
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    })
    .send(Buffer.from(bytes));
});
routes.on(workspaceApi.socialMutes, (_req, res) => {
  res.json({ mutes: mutes(res.locals.owner) });
});
routes.on(workspaceApi.socialMute, (req, res) => {
  const { phrase } = req.body;
  res.json({ mutes: muteWords(res.locals.owner, phrase) });
});
routes.on(workspaceApi.socialUnmute, (req, res) => {
  const { phrase } = req.body;
  res.json({ mutes: unmuteWords(res.locals.owner, phrase) });
});
routes.on(workspaceApi.socialRead, (req, res) => {
  const { stories } = req.body;
  res.json({ unread: markRead(res.locals.owner, stories, true) });
});
routes.on(workspaceApi.socialUnreadSet, (req, res) => {
  const { stories } = req.body;
  res.json({ unread: markRead(res.locals.owner, stories, false) });
});
routes.on(workspaceApi.socialDismiss, (req, res) => {
  const { stories } = req.body;
  res.json({ unread: dismissStories(res.locals.owner, stories, true) });
});
routes.on(workspaceApi.socialRestore, (req, res) => {
  const { stories } = req.body;
  res.json({ unread: dismissStories(res.locals.owner, stories, false) });
});
routes.on(workspaceApi.socialPreferences, (_req, res) => {
  res.json(feedPreferences(res.locals.owner));
});
routes.on(workspaceApi.socialPreferencesUpdate, (req, res) => {
  const change = req.body;
  res.json(setFeedPreferences(res.locals.owner, change));
});
routes.on(workspaceApi.socialReadAll, (req, res) => {
  const feed = req.body?.feed;
  res.json({ unread: markAllRead(res.locals.owner, feed) });
});
routes.on(workspaceApi.socialFeeds, (_req, res) => {
  res.json({
    added: addedFeeds(res.locals.owner),
    own: ownSources(res.locals.owner),
  });
});
// Feeds an owner adds by address, rather than from the catalog.
routes.on(workspaceApi.socialSourceDiscover, async (req, res) => {
  res.json(await discover(req.body));
});
routes.on(workspaceApi.socialSourceAdd, async (req, res) => {
  res.status(201).json(await addSource(res.locals.owner, req.body));
});
routes.on(workspaceApi.socialSourceDelete, (req, res) => {
  removeSource(res.locals.owner, req.params.id);
  res.json({ own: ownSources(res.locals.owner) });
});
routes.on(workspaceApi.socialOpmlImport, (req, res) => {
  const document = String(req.body?.opml ?? "");
  res.json(importOpml(res.locals.owner, document));
});
routes.on(workspaceApi.socialOpmlExport, (_req, res) => {
  res
    .type("application/xml")
    .set("content-disposition", 'attachment; filename="loop-feeds.opml"')
    .send(
      exportOpml(
        res.locals.owner,
        addedFeeds(res.locals.owner).map((id) => feedById.get(id)!),
      ),
    );
});
routes.on(workspaceApi.socialFeedAdd, (req, res) => {
  const feed = catalogFeed(req.params.id);
  feedSubscriptionsQueries.insert(db, res.locals.owner, feed.id, now());
  res.json({ added: addedFeeds(res.locals.owner) });
});
routes.on(workspaceApi.socialFeedDelete, (req, res) => {
  const feed = catalogFeed(req.params.id);
  feedSubscriptionsQueries.remove(db, res.locals.owner, feed.id);
  res.json({ added: addedFeeds(res.locals.owner) });
});
