import { describe, expect, it } from "vitest";
import {
  interleaveFeed,
  paceStreamItems,
  type AgentFeedEntry,
} from "../src/shared/feed-interleave.js";
import {
  defaultStreamAskPrompt,
  safeHttpUrl,
  socialStoryToStreamItem,
  type StreamItem,
} from "../src/shared/stream-item.js";
import type { FeedEntry, SocialStory } from "../src/shared/news.js";

const hnFeed: FeedEntry = {
  id: "hackernews",
  name: "Hacker News",
  category: "Tech news",
  description: "HN",
  home: "news.ycombinator.com",
  url: "https://news.ycombinator.com/rss",
  color: "#ff6600",
  kind: "story",
  mark: "hn",
};

const blogFeed: FeedEntry = {
  id: "simonwillison",
  name: "Simon Willison",
  category: "Engineering",
  description: "Blog",
  home: "simonwillison.net",
  url: "https://simonwillison.net/atom/everything/",
  color: "#3b82f6",
  kind: "article",
};

function makeStory(overrides: Partial<SocialStory> = {}): SocialStory {
  return {
    id: "hackernews:1",
    title: "Test story",
    url: "https://example.com/post",
    site: "example.com",
    comments_url: "https://news.ycombinator.com/item?id=1",
    published_at: 1_700_000_000_000,
    community: null,
    author: "alice",
    points: 42,
    comments: 10,
    summary: "Short summary.",
    image: null,
    media: null,
    feed: "hackernews",
    first_seen_at: 1_700_000_000_000,
    read: false,
    ...overrides,
  };
}

function makeStream(overrides: Partial<StreamItem> = {}): StreamItem {
  const base = socialStoryToStreamItem(makeStory(), hnFeed);
  return {
    ...base,
    ...overrides,
  };
}

function makeAgent(id: string, unread = true): AgentFeedEntry<{ id: string }> {
  return { item: { id }, key: `done:${id}`, unread };
}

describe("stream-item helpers", () => {
  it("sanitizes unsafe URLs and preserves http(s) links", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1",
    );
    expect(safeHttpUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it("maps a SocialStory to a namespaced StreamItem and drops unsafe URLs", () => {
    const item = socialStoryToStreamItem(
      makeStory({
        id: "hackernews:99",
        url: "javascript:evil()",
        comments_url: "https://news.ycombinator.com/item?id=99",
        summary: "  Interesting read  ",
        published_at: null,
        first_seen_at: 12345,
      }),
      hnFeed,
      { highSignal: true },
    );

    expect(item.id).toBe("rss:hackernews:99");
    expect(item.rawId).toBe("hackernews:99");
    expect(item.kind).toBe("rss");
    expect(item.sourceId).toBe("hackernews");
    expect(item.sourceLabel).toBe("Hacker News");
    expect(item.url).toBeNull();
    expect(item.discussionUrl).toBe("https://news.ycombinator.com/item?id=99");
    expect(item.excerpt).toBe("Interesting read");
    expect(item.timestamp).toBe(12345);
    expect(item.highSignal).toBe(true);
  });

  it("builds default ask prompts for both rss and future email items", () => {
    const rss = socialStoryToStreamItem(makeStory(), hnFeed);
    expect(defaultStreamAskPrompt(rss)).toBe(
      "About this Hacker News story: Test story\nhttps://example.com/post\nDiscussion: https://news.ycombinator.com/item?id=1\n\n",
    );

    const email: StreamItem = {
      ...rss,
      id: "email:msg-1",
      rawId: "msg-1",
      kind: "email",
      sourceLabel: "Jane Doe",
      agentPromptContext: {
        kind: "email",
        sourceLabel: "Jane Doe",
        itemKindLabel: "email",
        title: "Q4 Architecture Review",
        url: null,
        discussionUrl: null,
        excerpt: "Can we review the queue?",
      },
    };
    expect(defaultStreamAskPrompt(email)).toBe(
      "About this email from Jane Doe: Q4 Architecture Review\n\n",
    );
  });
});

describe("paceStreamItems", () => {
  it("caps high-volume feeds per pass and avoids back-to-back items from the same source", () => {
    // 5 newer HN stories + 2 slightly older blog posts
    const items = [
      makeStream({ id: "rss:hn1", sourceId: "hackernews", timestamp: 500 }),
      makeStream({ id: "rss:hn2", sourceId: "hackernews", timestamp: 490 }),
      makeStream({ id: "rss:hn3", sourceId: "hackernews", timestamp: 480 }),
      makeStream({ id: "rss:hn4", sourceId: "hackernews", timestamp: 470 }),
      makeStream({ id: "rss:hn5", sourceId: "hackernews", timestamp: 460 }),
      makeStream({ id: "rss:b1", sourceId: "simonwillison", timestamp: 400 }),
      makeStream({ id: "rss:b2", sourceId: "simonwillison", timestamp: 390 }),
    ];

    const paced = paceStreamItems(items, 2);
    // Pass 1 takes at most 2 per source, alternating sources: hn1, b1, hn2, b2
    expect(paced.slice(0, 4).map((s) => s.id)).toEqual([
      "rss:hn1",
      "rss:b1",
      "rss:hn2",
      "rss:b2",
    ]);
    // Remaining HN items follow in chronological order
    expect(paced.slice(4).map((s) => s.id)).toEqual([
      "rss:hn3",
      "rss:hn4",
      "rss:hn5",
    ]);
  });

  it("places high-signal items ahead of ordinary stream items", () => {
    const items = [
      makeStream({ id: "rss:hn1", sourceId: "hackernews", timestamp: 900 }),
      makeStream({
        id: "rss:watch1",
        sourceId: "simonwillison",
        timestamp: 100,
        highSignal: true,
      }),
    ];

    const paced = paceStreamItems(items, 2);
    expect(paced.map((s) => s.id)).toEqual(["rss:watch1", "rss:hn1"]);
  });
});

describe("interleaveFeed", () => {
  it("returns only agent rows when source is agents", () => {
    const res = interleaveFeed(
      [makeAgent("a1"), makeAgent("a2")],
      [makeStream({ id: "rss:1" })],
      "agents",
    );
    expect(res.rows.map((r) => r.key)).toEqual(["done:a1", "done:a2"]);
    expect(res.hasMoreStreams).toBe(false);
  });

  it("returns chronological filtered stream rows when source is feeds", () => {
    const streams = [
      makeStream({ id: "rss:old", timestamp: 100, read: true }),
      makeStream({ id: "rss:new", timestamp: 300, read: false }),
      makeStream({ id: "rss:mid", timestamp: 200, read: false }),
    ];

    const allFeeds = interleaveFeed([makeAgent("a1")], streams, "feeds", "all");
    expect(allFeeds.rows.map((r) => r.key)).toEqual([
      "rss:new",
      "rss:mid",
      "rss:old",
    ]);

    const unreadFeeds = interleaveFeed(
      [makeAgent("a1")],
      streams,
      "feeds",
      "unread",
    );
    expect(unreadFeeds.rows.map((r) => r.key)).toEqual(["rss:new", "rss:mid"]);

    const readFeeds = interleaveFeed(
      [makeAgent("a1")],
      streams,
      "feeds",
      "read",
    );
    expect(readFeeds.rows.map((r) => r.key)).toEqual(["rss:old"]);
  });

  it("leads with agent Done card and weaves unread RSS items at configured ratio", () => {
    const agents = [makeAgent("a1"), makeAgent("a2")];
    const streams = [
      makeStream({ id: "rss:hn1", sourceId: "hackernews", timestamp: 500 }),
      makeStream({ id: "rss:b1", sourceId: "simonwillison", timestamp: 450 }),
      makeStream({ id: "rss:hn2", sourceId: "hackernews", timestamp: 400 }),
      makeStream({ id: "rss:b2", sourceId: "simonwillison", timestamp: 350 }),
      makeStream({
        id: "rss:read1",
        sourceId: "simonwillison",
        timestamp: 999,
        read: true,
      }),
    ];

    const res = interleaveFeed(agents, streams, "all", "all", { ratio: 2 });
    // Read RSS item is excluded from default mixed All stream.
    // Agent card leads, followed by 2 diverse RSS items, then agent 2, then remaining 2.
    expect(res.rows.map((r) => r.key)).toEqual([
      "done:a1",
      "rss:hn1",
      "rss:b1",
      "done:a2",
      "rss:hn2",
      "rss:b2",
    ]);
    expect(res.hasMoreStreams).toBe(false);
  });

  it("surfaces high-signal stream items right after the top agent card", () => {
    const agents = [makeAgent("a1"), makeAgent("a2")];
    const streams = [
      makeStream({ id: "rss:hn1", sourceId: "hackernews", timestamp: 500 }),
      makeStream({
        id: "rss:watch",
        sourceId: "simonwillison",
        timestamp: 100,
        highSignal: true,
      }),
    ];

    const res = interleaveFeed(agents, streams, "all", "all", { ratio: 1 });
    expect(res.rows.map((r) => r.key)).toEqual([
      "done:a1",
      "rss:watch",
      "rss:hn1",
      "done:a2",
    ]);
  });

  it("handles zero agent cards gracefully and enforces maxMixedStreams", () => {
    const streams = [
      makeStream({ id: "rss:1", sourceId: "hackernews", timestamp: 300 }),
      makeStream({ id: "rss:2", sourceId: "simonwillison", timestamp: 200 }),
      makeStream({ id: "rss:3", sourceId: "hackernews", timestamp: 100 }),
    ];

    const res = interleaveFeed([], streams, "all", "all", {
      maxMixedStreams: 2,
    });
    expect(res.rows.map((r) => r.key)).toEqual(["rss:1", "rss:2"]);
    expect(res.hasMoreStreams).toBe(true);
  });

  it("returns agents unchanged when no eligible RSS items exist", () => {
    const agents = [makeAgent("a1")];
    const res = interleaveFeed(agents, [], "all", "all");
    expect(res.rows.map((r) => r.key)).toEqual(["done:a1"]);
    expect(res.hasMoreStreams).toBe(false);
  });

  it("is deterministic on equal timestamps", () => {
    const a = socialStoryToStreamItem(
      makeStory({ id: "b:2", published_at: 1000 }),
      blogFeed,
    );
    const b = socialStoryToStreamItem(
      makeStory({ id: "a:1", published_at: 1000 }),
      blogFeed,
    );
    const res = interleaveFeed([], [a, b], "feeds", "all");
    expect(res.rows.map((r) => r.key)).toEqual(["rss:a:1", "rss:b:2"]);
  });
});
