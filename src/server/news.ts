import { Router } from "express";
import { db, now } from "./db.js";
import { Problem } from "./domain.js";
import { parseFeed } from "./syndication.js";
import {
  feedById,
  type FeedEntry,
  type NewsStory,
  type SocialResponse,
  type SocialStory,
} from "../shared/news.js";

// Social shows the public feeds an owner added from the catalog in
// src/shared/news.ts. The feeds hold no account data, so one cached copy per
// feed serves every owner, and only catalog addresses (and redirects within
// their own sites) are ever fetched. Stories are only shown to you: nothing
// read here is passed to an agent.

const FRESH_MS = 5 * 60_000;
// A feed that failed is retried after this, not on every load.
const RETRY_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
// Each feed's newest stories, so one busy feed doesn't bury the others.
const PER_FEED = 20;
const MAX_STORIES = 200;

type NewsFetch = (url: string, init: RequestInit) => Promise<Response>;
let newsFetch: NewsFetch = (url, init) => fetch(url, init);
type Shown = { stories: NewsStory[]; fetched_at: number };
const cached = new Map<string, Shown>();
const failed = new Map<string, { error: unknown; failed_at: number }>();
const pending = new Map<string, Promise<NewsStory[]>>();

/** Tests swap the network for a fixture; returns a restore function. */
export function withNewsFixture(fetcher: NewsFetch) {
  const previous = newsFetch;
  newsFetch = fetcher;
  cached.clear();
  failed.clear();
  return () => {
    newsFetch = previous;
    cached.clear();
    failed.clear();
  };
}

/**
 * Where a redirect leads, if it stays on the feed's own site: the same host
 * or one under it (www. aside), the same port, and never from https to http.
 */
function redirectTarget(feed: FeedEntry, from: string, location: string) {
  const origin = new URL(feed.url);
  const site = origin.hostname.replace(/^www\./, "");
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new Error(`${feed.name} redirected to an invalid address`);
  }
  const sameSite =
    (next.hostname === site || next.hostname.endsWith(`.${site}`)) &&
    next.port === origin.port &&
    (next.protocol === "https:" ||
      (next.protocol === "http:" && origin.protocol === "http:"));
  if (!sameSite)
    throw new Error(`${feed.name} redirected away from ${origin.hostname}`);
  return next.href;
}

/** The body as text, refused as soon as it passes MAX_BYTES. */
async function readCapped(response: Response, name: string) {
  const tooLarge = () => new Error(`${name} feed is too large`);
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function download(feed: FeedEntry) {
  const { name } = feed;
  // One deadline covers every redirect and the whole body.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = feed.url;
  for (let hops = 0; ; hops++) {
    const response = await newsFetch(url, {
      // Reddit refuses requests without a descriptive User-Agent.
      headers: {
        accept:
          "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.8",
        "user-agent": "Loop/1.0 (feed reader)",
      },
      // Redirects are followed here, so each one is checked first.
      redirect: "manual",
      signal,
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      response.body?.cancel().catch(() => {});
      if (hops >= MAX_REDIRECTS)
        throw new Error(`${name} redirected too many times`);
      url = redirectTarget(feed, url, location);
      continue;
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      throw new Error(`${name} answered ${response.status}`);
    }
    const { stories } = parseFeed(await readCapped(response, name), url);
    if (!stories.length) throw new Error(`${name} feed had no stories`);
    return stories;
  }
}

/**
 * Fresh stories, refetched at most every five minutes by one request at a
 * time. A failure is remembered too, so a broken feed is retried every two
 * minutes rather than on every load.
 */
export async function feedStories(feed: FeedEntry, at = Date.now()) {
  const last = cached.get(feed.id);
  if (last && at - last.fetched_at < FRESH_MS) return last;
  const failure = failed.get(feed.id);
  if (failure && at - failure.failed_at < RETRY_MS) {
    if (last) return last;
    throw failure.error;
  }
  let request = pending.get(feed.id);
  if (!request) {
    request = download(feed).finally(() => pending.delete(feed.id));
    pending.set(feed.id, request);
  }
  try {
    const shown = { stories: await request, fetched_at: at };
    cached.set(feed.id, shown);
    failed.delete(feed.id);
    return shown;
  } catch (error) {
    failed.set(feed.id, { error, failed_at: at });
    // A stale list beats an error.
    if (last) return last;
    throw error;
  }
}

export function addedFeeds(owner: string): string[] {
  return (
    db
      .prepare(
        "SELECT feed_id FROM feed_subscriptions WHERE owner_id=? ORDER BY created_at, feed_id",
      )
      .all(owner) as { feed_id: string }[]
  )
    .map((row) => row.feed_id)
    .filter((id) => feedById.has(id));
}

/** Every added feed's newest stories in one list, newest first. */
export async function socialStories(
  owner: string,
  at = Date.now(),
): Promise<SocialResponse> {
  const feeds = addedFeeds(owner).map((id) => feedById.get(id)!);
  const results = await Promise.allSettled(
    feeds.map((feed) => feedStories(feed, at)),
  );
  const seen = new Set<string>();
  const stories: SocialStory[] = [];
  const failed: string[] = [];
  results.forEach((result, index) => {
    const feed = feeds[index];
    if (result.status === "rejected") return void failed.push(feed.id);
    for (const story of result.value.stories.slice(0, PER_FEED)) {
      // The same article from two feeds is shown once.
      if (seen.has(story.url)) continue;
      seen.add(story.url);
      stories.push({ ...story, id: `${feed.id}:${story.id}`, feed: feed.id });
    }
  });
  // Undated stories keep their feed's order after the dated ones.
  stories.sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
  return { stories: stories.slice(0, MAX_STORIES), failed };
}

function catalogFeed(id: string) {
  const feed = feedById.get(id);
  if (!feed) throw new Problem(404, "No such feed.");
  return feed;
}

export const news = Router();
news.get("/social", async (_req, res) => {
  res.json(await socialStories(res.locals.owner));
});
news.get("/social/feeds", (_req, res) => {
  res.json({ added: addedFeeds(res.locals.owner) });
});
news.put("/social/feeds/:id", (req, res) => {
  const feed = catalogFeed(req.params.id);
  db.prepare(
    "INSERT OR IGNORE INTO feed_subscriptions(owner_id, feed_id, created_at) VALUES(?,?,?)",
  ).run(res.locals.owner, feed.id, now());
  res.json({ added: addedFeeds(res.locals.owner) });
});
news.delete("/social/feeds/:id", (req, res) => {
  const feed = catalogFeed(req.params.id);
  db.prepare(
    "DELETE FROM feed_subscriptions WHERE owner_id=? AND feed_id=?",
  ).run(res.locals.owner, feed.id);
  res.json({ added: addedFeeds(res.locals.owner) });
});
