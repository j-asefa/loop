import { afterAll, afterEach, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-news-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { errorHandler } = await import("../src/server/error-handler");
const { parseFeed } = await import("../src/server/syndication");
const {
  news,
  withNewsFixture,
  socialStories,
  feedStories,
  refreshDueFeeds,
  forgetAbandoned,
  forgetCachedStories,
} = await import("../src/server/news");
const { db } = await import("../src/server/db");
const storedFeedStories = (feed: string) =>
  db
    .prepare(
      "SELECT title FROM feed_stories WHERE feed_id=? ORDER BY COALESCE(published_at,first_seen_at) DESC",
    )
    .all(feed) as { title: string }[];
const { feedById, feedCatalog, sameStoryUrl } =
  await import("../src/shared/news");
const HACKER_NEWS_RSS = feedById.get("hackernews")!.url;
const LOBSTERS_RSS = feedById.get("lobsters")!.url;
// Reddit is not in the catalog (it answers 429 logged out), but Social still
// reads a subreddit's shape for anyone who adds one as their own feed.
const REDDIT_ATOM = "https://www.reddit.com/r/programming/hot/.rss?limit=50";

const { mobile } = await import("../src/server/mobile-routes");
const owner = (req: any, res: any, next: any) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
};
const app = express();
app.use(express.json());
app.use(owner);
app.use(news);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
const laterApp = express();
laterApp.use(express.json());
laterApp.use(owner);
laterApp.use(mobile);
laterApp.use(errorHandler);
const later = laterApp.listen(0, "127.0.0.1");
await Promise.all(
  [server, later].map(
    (listener) =>
      new Promise<void>((resolve) => listener.once("listening", resolve)),
  ),
);
async function call(path: string, method = "GET", owner = "alice") {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}${path}`,
    { method, headers: { "x-owner": owner } },
  );
  return { status: response.status, data: await response.json() };
}
const get = (path: string, owner?: string) => call(path, "GET", owner);
async function send(
  path: string,
  method: string,
  body?: unknown,
  owner = "alice",
) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}${path}`,
    {
      method,
      headers: { "x-owner": owner, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: response.status, data: await response.json() };
}
/** Later lives on the mobile routes; a saved story is read back through them. */
async function laterCall(
  path: string,
  method: string,
  body?: unknown,
  owner = "alice",
) {
  const response = await fetch(
    `http://127.0.0.1:${(later.address() as any).port}${path}`,
    {
      method,
      headers: { "x-owner": owner, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: response.status, data: await response.json() };
}
let restore = () => {};
afterEach(() => restore());
afterAll(async () => {
  await Promise.all(
    [server, later].map(
      (listener) =>
        new Promise<void>((resolve) => listener.close(() => resolve())),
    ),
  );
  rmSync(dir, { recursive: true, force: true });
});

// The shape of news.ycombinator.com/rss, trimmed to the cases that matter.
const officialRss = `<rss version="2.0"><channel><title>Hacker News</title>
<item><title>Run a 125B model at 100T&#x2F;s &amp; more</title><link>https://www.github.com/acme/strata</link><pubDate>Sun, 04 Oct 2026 12:51:53 +0000</pubDate><comments>https://news.ycombinator.com/item?id=49953495</comments><description><![CDATA[<a href="https://news.ycombinator.com/item?id=49953495">Comments</a>]]></description></item>
<item><title>Ask HN: What are you working on?</title><link>https://news.ycombinator.com/item?id=49950000</link><pubDate>Sat, 03 Oct 2026 09:00:00 +0000</pubDate><comments>https://news.ycombinator.com/item?id=49950000</comments></item>
<item><title>Sneaky</title><link>javascript:alert(1)</link><pubDate>Sat, 03 Oct 2026 09:00:00 +0000</pubDate></item>
<item><title>Run a 125B model again</title><link>https://example.com/dup</link><comments>https://news.ycombinator.com/item?id=49953495</comments></item>
</channel></rss>`;

it("reads stories from the official Hacker News feed", () => {
  const { stories } = parseFeed(officialRss, HACKER_NEWS_RSS);
  expect(stories).toEqual([
    {
      id: "49953495",
      title: "Run a 125B model at 100T/s & more",
      url: "https://www.github.com/acme/strata",
      site: "github.com",
      comments_url: "https://news.ycombinator.com/item?id=49953495",
      published_at: Date.parse("2026-10-04T12:51:53Z"),
      community: null,
      author: null,
      points: null,
      comments: null,
      summary: null,
      image: null,
      media: null,
    },
    expect.objectContaining({
      id: "49950000",
      title: "Ask HN: What are you working on?",
      site: null,
    }),
  ]);
});

it("reads points, comments and authors from richer feeds", () => {
  const {
    stories: [story],
  } = parseFeed(
    `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<item><title><![CDATA[Homa: The end of TCP? [video]]]></title><description><![CDATA[
<p>Comments URL: <a href="https://news.ycombinator.com/item?id=1">x</a></p>
<p>Points: 218</p>
<p># Comments: 122</p>
]]></description><pubDate>Sun, 04 Oct 2026 19:42:25 +0000</pubDate><link>https://www.youtube.com/watch?v=x</link><dc:creator>signa11</dc:creator><comments>https://news.ycombinator.com/item?id=1</comments></item>
</channel></rss>`,
    "https://hnrss.org/frontpage",
  );
  expect(story).toMatchObject({
    id: "1",
    title: "Homa: The end of TCP? [video]",
    site: "youtube.com",
    author: "signa11",
    points: 218,
    comments: 122,
  });
});

// The shape of reddit.com/r/<subreddits>/hot/.rss, trimmed: a link post, a
// self post, a post whose "[link]" is not a web link, and a repeat.
const redditAtom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>programming</title>
<entry><author><name>/u/double-happiness</name><uri>https://www.reddit.com/user/double-happiness</uri></author><category term="programming" label="r/programming"/><content type="html">&amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/double-happiness&quot;&gt; /u/double-happiness &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://www.youtube.com/watch?v=9A&amp;amp;t=1&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/programming/comments/1wxoefa/8pinski/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content><id>t3_1wxoefa</id><link href="https://www.reddit.com/r/programming/comments/1wxoefa/8pinski/" /><updated>2026-10-04T19:34:01+00:00</updated><published>2026-10-04T19:34:01+00:00</published><title>&quot;8-pinski&quot; - EIGHT(!) bytes intro for MSDOS</title></entry>
<entry><author><name>/u/Rupour</name></author><category term="technology" label="r/technology"/><content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;A blog post.&lt;/p&gt;&lt;/div&gt; submitted by &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/technology/comments/1wxd33z/red_green/&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt;</content><id>t3_1wxd33z</id><link href="https://www.reddit.com/r/technology/comments/1wxd33z/red_green/" /><published>2026-10-04T11:08:30+00:00</published><title>Red, green and mud</title></entry>
<entry><author><name>/u/x</name></author><content type="html">&lt;a href=&quot;javascript:alert(1)&quot;&gt;[link]&lt;/a&gt;</content><id>t3_bad</id><link href="https://www.reddit.com/r/programming/comments/bad/x/" /><title>Sneaky</title></entry>
<entry><author><name>/u/y</name></author><content type="html"></content><id>t3_bad2</id><link href="javascript:alert(1)" /><title>Sneakier</title></entry>
<entry><id>t3_1wxoefa</id><link href="https://www.reddit.com/r/programming/comments/1wxoefa/again/" /><title>Repeat</title></entry>
</feed>`;

// Lobsters: two dated stories and one undated, as a second feed to merge.
const lobstersRss = `<rss version="2.0"><channel><title>Lobsters</title><link>https://lobste.rs/</link>
<item><title>Zig 0.15 released</title><link>https://ziglang.org/news/0.15</link><comments>https://lobste.rs/s/abc</comments><pubDate>Sun, 04 Oct 2026 20:00:00 +0000</pubDate></item>
<item><title>On sorting</title><link>https://example.net/sorting</link><comments>https://lobste.rs/s/def</comments><pubDate>Sat, 03 Oct 2026 10:00:00 +0000</pubDate></item>
<item><title>Undated musing</title><link>https://example.net/musing</link></item>
</channel></rss>`;

it("reads posts from Reddit's Atom feed", () => {
  const posts = parseFeed(redditAtom, REDDIT_ATOM).stories;
  expect(posts).toEqual([
    {
      id: "t3_1wxoefa",
      title: '"8-pinski" - EIGHT(!) bytes intro for MSDOS',
      url: "https://www.youtube.com/watch?v=9A&t=1",
      site: "youtube.com",
      comments_url:
        "https://www.reddit.com/r/programming/comments/1wxoefa/8pinski/",
      published_at: Date.parse("2026-10-04T19:34:01Z"),
      community: "r/programming",
      author: "u/double-happiness",
      points: null,
      comments: null,
      summary: null,
      image: null,
      media: null,
    },
    expect.objectContaining({
      id: "t3_1wxd33z",
      url: "https://www.reddit.com/r/technology/comments/1wxd33z/red_green/",
      site: null,
      community: "r/technology",
      summary: "A blog post.",
    }),
    // A "[link]" that is not a web link falls back to the comments page.
    expect.objectContaining({
      id: "t3_bad",
      url: "https://www.reddit.com/r/programming/comments/bad/x/",
      community: null,
    }),
  ]);
});

// Social: the catalog, each owner's added feeds, and the merged list.
it("lists only public http(s) catalog feeds with unique ids", () => {
  expect(new Set(feedCatalog.map((f) => f.id)).size).toBe(feedCatalog.length);
  const categories = new Set(feedCatalog.map((f) => f.category));
  for (const feed of feedCatalog) {
    expect(feed.url).toMatch(/^https:\/\//);
    // Reddit's logged-out RSS answers 429: it is not a feed Loop can offer.
    expect(new URL(feed.url).hostname).not.toMatch(/(^|\.)reddit\.com$/);
    expect(feed.home).toBeTruthy();
    expect(feed.home).not.toMatch(/^www\./);
    expect(feed.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(feed.description.length).toBeGreaterThan(19);
    expect(feed.description.length).toBeLessThan(141);
    expect(feed.description.endsWith(".")).toBe(true);
    expect(categories.has(feed.category)).toBe(true);
    if (feed.mark)
      expect(["hn", "reddit", "github", "youtube"]).toContain(feed.mark);
  }
  expect(categories).toContain("Communities");
});

it("adds and removes catalog feeds per owner", async () => {
  expect((await get("/social/feeds", "bob")).data).toEqual({
    added: [],
    own: [],
  });
  const added = await call("/social/feeds/hackernews", "PUT", "bob");
  expect(added.data).toEqual({ added: ["hackernews"] });
  // Adding twice is harmless; other owners are unaffected.
  await call("/social/feeds/hackernews", "PUT", "bob");
  expect((await get("/social/feeds", "bob")).data.added).toEqual([
    "hackernews",
  ]);
  expect((await get("/social/feeds", "carol")).data.added).toEqual([]);
  // Only catalog feeds can be added: never an address someone types.
  const unknown = await call("/social/feeds/twitter", "PUT", "bob");
  expect(unknown.status).toBe(404);
  const removed = await call("/social/feeds/hackernews", "DELETE", "bob");
  expect(removed.data).toEqual({ added: [] });
});

it("merges added feeds newest first, from one shared cache", async () => {
  const asked: string[] = [];
  restore = withNewsFixture(async (url, init) => {
    asked.push(url);
    expect(new Headers(init.headers).get("user-agent")).toMatch(/Loop/);
    return new Response(url === LOBSTERS_RSS ? lobstersRss : officialRss);
  });
  for (const owner of ["dana", "erin"]) {
    await call("/social/feeds/hackernews", "PUT", owner);
    await call("/social/feeds/lobsters", "PUT", owner);
  }
  const { status, data } = await get("/social", "dana");
  expect(status).toBe(200);
  expect(data.failed).toEqual([]);
  expect(
    data.stories.map((s: any) => [s.feed, s.title, s.id.split(":")[0]]),
  ).toEqual([
    // An undated story sorts by when Loop first read it, which is now.
    ["lobsters", "Undated musing", "lobsters"],
    ["lobsters", "Zig 0.15 released", "lobsters"],
    ["hackernews", "Run a 125B model at 100T/s & more", "hackernews"],
    ["lobsters", "On sorting", "lobsters"],
    ["hackernews", "Ask HN: What are you working on?", "hackernews"],
  ]);
  // A second owner with the same feeds is served from the same copies.
  await get("/social", "erin");
  expect(asked.sort()).toEqual([HACKER_NEWS_RSS, LOBSTERS_RSS].sort());
});

it("keeps the last good copy and names feeds it can't load", async () => {
  let fail = false;
  let calls = 0;
  restore = withNewsFixture(async (url) => {
    calls++;
    if (fail || url === LOBSTERS_RSS)
      return new Response("down", { status: 503 });
    return new Response(officialRss);
  });
  await call("/social/feeds/hackernews", "PUT", "frank");
  await call("/social/feeds/lobsters", "PUT", "frank");
  const first = await get("/social", "frank");
  expect(first.data.failed).toEqual(["lobsters"]);
  expect(first.data.stories).toHaveLength(2);
  // After five minutes Hacker News is refetched; its failure keeps the old
  // list. Lobsters is past its first two-minute backoff, so it is tried again.
  fail = true;
  const later = await socialStories("frank", Date.now() + 6 * 60_000);
  expect(calls).toBe(4);
  expect(later.stories).toHaveLength(2);
  expect(later.failed).toEqual(["lobsters"]);
});

it("reads a blog's Atom feed, resolving relative links", () => {
  const feed = parseFeed(
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="html">Ann &amp;amp; Bo</title>
<link rel="self" href="https://blog.example/atom.xml"/><link href="https://blog.example/"/>
<entry><title type="html">&lt;em&gt;Faster&lt;/em&gt; builds</title><link rel="alternate" type="text/html" href="/2026/builds"/><link rel="replies" type="text/html" href="/2026/builds#comments" thr:count="7"/><id>tag:blog.example,2026:1</id><updated>2026-10-01T10:00:00Z</updated><author><name>Ann</name></author><summary type="html">&lt;p&gt;We cut CI time &amp;mdash; in half.&lt;/p&gt;</summary></entry>
<entry><title>Sneaky</title><link href="javascript:alert(1)"/><id>x</id></entry>
</feed>`,
    "https://blog.example/atom.xml",
  );
  expect(feed).toEqual({
    title: "Ann & Bo",
    home: "https://blog.example/",
    stories: [
      {
        id: "tag:blog.example,2026:1",
        title: "Faster builds",
        url: "https://blog.example/2026/builds",
        site: null,
        comments_url: "https://blog.example/2026/builds#comments",
        published_at: Date.parse("2026-10-01T10:00:00Z"),
        community: null,
        author: "Ann",
        points: null,
        comments: 7,
        summary: "We cut CI time — in half.",
        image: null,
        media: null,
      },
    ],
  });
});

it("reads RSS 1.0, JSON Feed and untitled microblog posts", () => {
  const rdf = parseFeed(
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://news.example/"><title>News</title><link>https://news.example/</link><items><rdf:Seq><rdf:li resource="https://news.example/1"/></rdf:Seq></items></channel>
<item rdf:about="https://news.example/1"><title>One</title><dc:date>2026-10-02T08:00:00Z</dc:date><dc:creator>someone@example.com (Sam)</dc:creator></item>
</rdf:RDF>`,
    "https://news.example/index.rdf",
  );
  expect(rdf.stories).toEqual([
    expect.objectContaining({
      id: "https://news.example/1",
      title: "One",
      url: "https://news.example/1",
      author: "Sam",
      published_at: Date.parse("2026-10-02T08:00:00Z"),
    }),
  ]);

  const json = parseFeed(
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "Linked",
      home_page_url: "https://linked.example/",
      items: [
        {
          id: "1",
          url: "https://linked.example/1",
          external_url: "https://elsewhere.example/story",
          title: "A good read",
          content_text: "Worth <it>.",
          date_published: "2026-10-03T00:00:00Z",
          authors: [{ name: "Lin" }],
        },
      ],
    }),
    "https://linked.example/feed.json",
  );
  expect(json.stories[0]).toMatchObject({
    url: "https://elsewhere.example/story",
    site: "elsewhere.example",
    comments_url: "https://linked.example/1",
    author: "Lin",
    summary: "Worth <it>.",
  });

  const toots = parseFeed(
    `<rss version="2.0"><channel><title>Someone</title><link>https://social.example/@someone</link>
<item><guid isPermaLink="true">https://social.example/@someone/1</guid><link>https://social.example/@someone/1</link><pubDate>Fri, 02 Oct 2026 08:00:00 +0000</pubDate><description>&lt;p&gt;Shipped it!&lt;/p&gt;</description></item>
<item><guid isPermaLink="true">https://social.example/@someone/2</guid><description></description></item>
</channel></rss>`,
    "https://social.example/@someone.rss",
  );
  expect(toots.stories).toEqual([
    expect.objectContaining({
      title: "Shipped it!",
      summary: null,
      site: null,
    }),
  ]);
});

it("refuses documents that aren't feeds", () => {
  expect(() =>
    parseFeed("<html><body>Hi</body></html>", "https://x.example/"),
  ).toThrow(/isn’t an RSS, Atom or JSON feed/);
  expect(() => parseFeed('{"hello":1}', "https://x.example/")).toThrow(
    /no items/,
  );
});

it("parses pathological markup in linear time", () => {
  // Unclosed tags once made each opening tag rescan the rest of the document:
  // these took minutes. Linear parsing takes milliseconds; the bound is loose
  // for busy CI machines.
  const twoMegabytes = (open: string, repeated: string, close = "") =>
    open + repeated.repeat(2_000_000 / repeated.length) + close;
  for (const document of [
    twoMegabytes("<rss><channel>", "<item><title>x</title>"),
    twoMegabytes("<feed>", "<entry><title>x</title>"),
    twoMegabytes("<rss><channel>", "<!--"),
    twoMegabytes("<feed><entry>", "<link "),
    twoMegabytes("<rss><channel><item><title>", "<![CDATA["),
    twoMegabytes(
      "<rss><channel><item><link>https://x.example/</link><title>t</title><author>",
      "a@",
      " x</author></item>",
    ),
  ]) {
    const started = performance.now();
    try {
      parseFeed(document, "https://x.example/feed");
    } catch {}
    expect(performance.now() - started).toBeLessThan(2000);
  }
  // Only the first hundred items are read, so stories after a hundred
  // unusable items are never reached.
  const unusable = parseFeed(
    `<rss><channel>${"<item><title>No link</title></item>".repeat(100)}${officialRss}`,
    "https://x.example/feed",
  );
  expect(unusable.stories).toEqual([]);
});

const bluesky = feedById.get("bluesky")!;

it("remembers a failing feed instead of refetching it on every load", async () => {
  let calls = 0;
  let answer = () => new Response("down", { status: 503 });
  restore = withNewsFixture(async () => {
    calls++;
    return answer();
  });
  const at = Date.now();
  // Loads at the same time share one request.
  const both = await Promise.allSettled([
    feedStories(bluesky, at),
    feedStories(bluesky, at),
  ]);
  expect(both.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(calls).toBe(1);
  await expect(feedStories(bluesky, at + 60_000)).rejects.toThrow(/503/);
  expect(calls).toBe(1);
  // A document that isn't a feed is remembered the same way. The second
  // failure doubles the wait from two minutes to four.
  answer = () => new Response("<html>Sign in</html>");
  await expect(feedStories(bluesky, at + 2 * 60_000)).rejects.toThrow(
    /isn’t an RSS/,
  );
  await expect(feedStories(bluesky, at + 4 * 60_000)).rejects.toThrow(
    /isn’t an RSS/,
  );
  expect(calls).toBe(2);
  // Once the wait is over and it works again, the stories replace the failure.
  answer = () => new Response(officialRss);
  const fixed = await feedStories(bluesky, at + 6 * 60_000);
  expect(fixed.stories.length).toBeGreaterThan(0);
  expect(calls).toBe(3);
});

it("widens the wait while a feed keeps failing, and honours Retry-After", async () => {
  let calls = 0;
  let header: Record<string, string> = {};
  restore = withNewsFixture(async () => {
    calls++;
    return new Response("no", { status: 503, headers: header });
  });
  const at = Date.now();
  // Two minutes, then four, then eight: a feed that has gone for good is not
  // asked for every two minutes forever.
  for (const [minute, expected] of [
    [0, 1],
    [1, 1],
    [2, 2],
    [5, 2],
    [6, 3],
    [13, 3],
    [14, 4],
  ] as const) {
    await expect(feedStories(bluesky, at + minute * 60_000)).rejects.toThrow();
    expect([minute, calls]).toEqual([minute, expected]);
  }
  // A feed that asks to be left alone for longer is.
  restore();
  calls = 0;
  header = { "retry-after": "600" };
  restore = withNewsFixture(async () => {
    calls++;
    return new Response("no", { status: 429, headers: header });
  });
  const later = at + 60 * 60_000;
  await expect(feedStories(bluesky, later)).rejects.toThrow(/429/);
  await expect(feedStories(bluesky, later + 5 * 60_000)).rejects.toThrow(/429/);
  expect(calls).toBe(1);
  await expect(feedStories(bluesky, later + 11 * 60_000)).rejects.toThrow(
    /429/,
  );
  expect(calls).toBe(2);
});

it("says a feed needs an account when it redirects to a sign-in page", async () => {
  const asked: string[] = [];
  restore = withNewsFixture(async (url) => {
    asked.push(url);
    return new Response(null, {
      status: 302,
      headers: {
        location:
          "https://bsky.app/login/?reason=lor2&dest=" +
          encodeURIComponent(bluesky.url),
      },
    });
  });
  await expect(feedStories(bluesky)).rejects.toThrow(/needs an account/);
  // The sign-in page itself is never requested, so it cannot be parsed as a
  // feed and reported as broken markup.
  expect(asked).toEqual([bluesky.url]);
});

it("stops reading a feed once it has the stories, and refuses a runaway", async () => {
  let sent = 0;
  let cancelled = false;
  const endless = () =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 64_000;
        controller.enqueue(new Uint8Array(64_000).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
  restore = withNewsFixture(async () => new Response(endless()));
  // Nothing in it closes an item, so there is no prefix worth parsing: it is
  // refused at the ceiling rather than read forever.
  await expect(feedStories(bluesky)).rejects.toThrow(/too large/);
  expect(cancelled).toBe(true);
  expect(sent).toBeLessThan(8_500_000);

  // A declared length that is too large is refused before reading anything.
  sent = 0;
  cancelled = false;
  restore();
  restore = withNewsFixture(
    async () =>
      new Response(endless(), {
        headers: { "content-length": "50000000" },
      }),
  );
  await expect(feedStories(bluesky)).rejects.toThrow(/too large/);
  expect(sent).toBeLessThan(200_000);
});

it("reads only the start of a feed that ships whole articles", async () => {
  // A ten-megabyte full-text feed: Substack and most self-hosted blogs are
  // like this, and the old two-megabyte cap refused them outright.
  const article = "<p>" + "word ".repeat(4000) + "</p>";
  const entry = (n: number) =>
    `<entry><title>Post ${n}</title><link href="https://big.example/${n}"/><id>tag:big,${n}</id>` +
    `<updated>2026-10-0${(n % 9) + 1}T09:00:00Z</updated>` +
    `<content type="html">${article.replace(/</g, "&lt;")}</content></entry>`;
  let sent = 0;
  let cancelled = false;
  let n = 0;
  const feed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Big</title>`,
        ),
      );
    },
    pull(controller) {
      // Split each entry across chunks, including inside its closing tag.
      const text = entry(n++);
      for (let at = 0; at < text.length; at += 997) {
        const slice = new TextEncoder().encode(text.slice(at, at + 997));
        sent += slice.byteLength;
        controller.enqueue(slice);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  restore = withNewsFixture(async () => new Response(feed));
  const shown = await feedStories(bluesky);
  // The parser keeps fifty; reading stopped at a hundred items — about two
  // megabytes of these, and far short of the ten on offer.
  expect(shown.stories).toHaveLength(50);
  expect(shown.stories[0].title).toMatch(/^Post \d+$/);
  expect(cancelled).toBe(true);
  expect(sent).toBeLessThan(3_000_000);
});

it("finds closing tags however the chunks fall", async () => {
  // A closing tag can be split across more than two chunks. Carrying only the
  // last chunk forward meant the tag was never assembled, the item count
  // never advanced, and a perfectly readable feed was read to the ceiling and
  // refused for being too large.
  const entry = (n: number) =>
    `<entry><title>Post ${n}</title><link href="https://b.example/${n}"/>` +
    `<id>tag:b,${n}</id><updated>2026-10-05T09:00:00Z</updated></entry>`;
  for (const chunk of [1, 2, 3, 4, 7, 64_000]) {
    let sent = 0;
    let n = 0;
    restore();
    restore = withNewsFixture(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>B</title>`,
                ),
              );
            },
            pull(controller) {
              const text = entry(n++);
              for (let at = 0; at < text.length; at += chunk) {
                const slice = new TextEncoder().encode(
                  text.slice(at, at + chunk),
                );
                sent += slice.byteLength;
                controller.enqueue(slice);
              }
            },
          }),
        ),
    );
    const shown = await feedStories(bluesky);
    expect([chunk, shown.stories.length]).toEqual([chunk, 50]);
    // It stopped at the items it needed, not at the eight-megabyte ceiling.
    expect(sent).toBeLessThan(100_000);
  }
});

it("reads a JSON feed whole, and refuses one past the ceiling", async () => {
  const items = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    url: `https://json.example/${i}`,
    title: `Item ${i}`,
    date_published: "2026-10-05T09:00:00Z",
    content_text: "x".repeat(60_000),
  }));
  restore = withNewsFixture(
    async () =>
      new Response(
        JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items }),
      ),
  );
  // Over two megabytes, and a JSON document cannot be cut: it is read whole.
  const shown = await feedStories(bluesky);
  expect(shown.stories).toHaveLength(40);
});

it("follows redirects only within the feed's own site", async () => {
  const asked: string[] = [];
  const redirects: Record<string, string> = {
    // Same host, and a subdomain of it: followed.
    [bluesky.url]: "/profile/did:plc:z72i7hdynmk6r22z27h6tvur/rss",
    "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/rss":
      "https://feeds.bsky.app/bsky.rss",
  };
  restore = withNewsFixture(async (url, init) => {
    asked.push(url);
    expect(init.redirect).toBe("manual");
    return redirects[url]
      ? new Response(null, {
          status: 302,
          headers: { location: redirects[url] },
        })
      : new Response(officialRss);
  });
  const shown = await feedStories(bluesky);
  expect(shown.stories.length).toBeGreaterThan(0);
  expect(asked).toEqual([
    bluesky.url,
    "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/rss",
    "https://feeds.bsky.app/bsky.rss",
  ]);

  for (const [location, error] of [
    ["https://evil.example/rss", /redirected away from bsky\.app/],
    ["https://bsky.app.evil.example/rss", /redirected away/],
    ["http://bsky.app/rss", /redirected away/],
    ["https://bsky.app:8443/rss", /redirected away/],
    [bluesky.url, /too many times/],
  ] as const) {
    asked.length = 0;
    restore();
    restore = withNewsFixture(async (url) => {
      asked.push(url);
      return new Response(null, { status: 301, headers: { location } });
    });
    await expect(feedStories(bluesky)).rejects.toThrow(error);
    // A redirect off the site is never requested.
    expect(asked.every((url) => url.startsWith("https://bsky.app/"))).toBe(
      true,
    );
  }
  expect(asked).toHaveLength(4);
});

it("sends what it has and reports the feeds still loading", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  restore = withNewsFixture(async (url) => {
    if (url !== HACKER_NEWS_RSS) await held;
    return new Response(url === LOBSTERS_RSS ? lobstersRss : officialRss);
  });
  await call("/social/feeds/hackernews", "PUT", "gail");
  await call("/social/feeds/lobsters", "PUT", "gail");
  const first = await get("/social", "gail");
  // Hacker News answered; Lobsters is still loading, not failed.
  expect(first.data.pending).toEqual(["lobsters"]);
  expect(first.data.failed).toEqual([]);
  expect(first.data.stories.map((s: any) => s.feed)).toEqual([
    "hackernews",
    "hackernews",
  ]);
  release();
  // Asking again picks up the same request rather than starting another. The
  // released read finishes on its own schedule, so wait for its stories to
  // arrive rather than for a fixed moment.
  let second = await socialStories("gail");
  for (let tries = 0; tries < 100 && second.stories.length < 5; tries++) {
    await new Promise((done) => setTimeout(done, 20));
    second = await socialStories("gail");
  }
  expect(second.stories).toHaveLength(5);
  expect(second.failed).toEqual([]);
});

it("reads at most four feeds at once", async () => {
  let open = 0;
  let most = 0;
  restore = withNewsFixture(async () => {
    most = Math.max(most, ++open);
    await new Promise((done) => setTimeout(done, 5));
    open--;
    return new Response(officialRss);
  });
  const twelve = feedCatalog.slice(0, 12);
  for (const feed of twelve)
    await call(`/social/feeds/${feed.id}`, "PUT", "hank");
  await socialStories("hank", Date.now(), { wait: true });
  expect(most).toBe(4);
});

it("refreshes on request, but not more than twice a minute", async () => {
  let calls = 0;
  restore = withNewsFixture(async () => {
    calls++;
    return new Response(officialRss);
  });
  const at = Date.now();
  await feedStories(bluesky, at);
  expect(calls).toBe(1);
  // Inside the five minutes a plain read is served from the copy already read.
  await feedStories(bluesky, at + 60_000);
  expect(calls).toBe(1);
  // A deliberate refresh ignores that, down to a thirty-second floor.
  await feedStories(bluesky, at + 60_000, { force: true });
  expect(calls).toBe(2);
  await feedStories(bluesky, at + 70_000, { force: true });
  expect(calls).toBe(2);
  await feedStories(bluesky, at + 95_000, { force: true });
  expect(calls).toBe(3);
});

it("keeps what each feed knew about the same story", async () => {
  // The Verge carries the article; Hacker News carries the discussion and its
  // points. Whichever feed was added first must not decide which you see.
  const verge = `<rss version="2.0"><channel><title>The Verge</title><link>https://www.theverge.com/</link>
<item><title>A long read about builds</title><link>https://www.theverge.com/2026/builds?utm_source=feed</link><pubDate>Mon, 05 Oct 2026 08:00:00 +0000</pubDate><description>Why builds are slow.</description></item>
</channel></rss>`;
  const hn = `<rss version="2.0"><channel><title>Hacker News</title>
<item><title>A long read about builds</title><link>https://www.theverge.com/2026/builds</link><pubDate>Mon, 05 Oct 2026 09:00:00 +0000</pubDate><comments>https://news.ycombinator.com/item?id=1234</comments><description><![CDATA[<p>Points: 180<br/># Comments: 42]]></description></item>
</channel></rss>`;
  for (const [first, second] of [
    ["the-verge", "hackernews"],
    ["hackernews", "the-verge"],
  ] as const) {
    restore();
    restore = withNewsFixture(
      async (url) => new Response(url === HACKER_NEWS_RSS ? hn : verge),
    );
    const owner = `merge-${first}`;
    await call(`/social/feeds/${first}`, "PUT", owner);
    await call(`/social/feeds/${second}`, "PUT", owner);
    const { data } = await get("/social", owner);
    expect(data.stories).toHaveLength(1);
    expect(data.stories[0]).toMatchObject({
      title: "A long read about builds",
      points: 180,
      comments: 42,
      comments_url: "https://news.ycombinator.com/item?id=1234",
    });
  }
});

it("treats links that differ only in tracking as one story", () => {
  expect(sameStoryUrl("https://a.example/post?utm_source=x&id=2#top")).toBe(
    sameStoryUrl("https://a.example/post/?id=2"),
  );
  expect(sameStoryUrl("not a url")).toBe("not a url");
});

it("keeps stories in the database, so a restart still has them", async () => {
  let calls = 0;
  restore = withNewsFixture(async () => {
    calls++;
    return new Response(officialRss);
  });
  await call("/social/feeds/hackernews", "PUT", "iris");
  const first = await get("/social", "iris");
  expect(first.data.stories).toHaveLength(2);
  expect(calls).toBe(1);
  // What a restart loses is the in-memory copy, not the stories.
  forgetCachedStories();
  const second = await socialStories("iris", Date.now(), { wait: true });
  expect(second.stories).toHaveLength(2);
  expect(second.feeds).toEqual([
    expect.objectContaining({ id: "hackernews", stories: 2, error: null }),
  ]);
  expect(calls).toBe(1);
});

it("asks a feed whether anything changed, and takes 304 for an answer", async () => {
  const asked: (string | null)[] = [];
  let modified = true;
  restore = withNewsFixture(async (_url, init) => {
    const headers = new Headers(init.headers);
    asked.push(headers.get("if-none-match"));
    return modified
      ? new Response(officialRss, { headers: { etag: '"v1"' } })
      : new Response(null, { status: 304 });
  });
  const at = Date.now();
  await feedStories(bluesky, at);
  expect(asked).toEqual([null]);
  modified = false;
  const again = await feedStories(bluesky, at + 6 * 60_000);
  // The validator went out, nothing came back, and the stories are still here.
  expect(asked).toEqual([null, '"v1"']);
  expect(again.stories).toHaveLength(2);
  expect(again.fetched_at).toBe(at + 6 * 60_000);
});

it("keeps only the newest stories of each feed", async () => {
  const story = (n: number) =>
    `<item><title>Story ${n}</title><link>https://x.example/${n}</link><pubDate>${new Date(
      Date.UTC(2026, 0, 1) + n * 60_000,
    ).toUTCString()}</pubDate></item>`;
  let from = 0;
  restore = withNewsFixture(
    async () =>
      new Response(
        `<rss version="2.0"><channel><title>Lots</title>${Array.from(
          { length: 60 },
          (_, i) => story(from + i),
        ).join("")}</channel></rss>`,
      ),
  );
  // Fifty at a time: the parser reads no more of a document than that.
  const at = Date.now();
  for (const [round, start] of [0, 100, 200].entries()) {
    from = start;
    await feedStories(bluesky, at + round * 6 * 60_000);
  }
  const kept = storedFeedStories(bluesky.id);
  // A hundred and twenty of the hundred and fifty that arrived, newest first.
  expect(kept).toHaveLength(120);
  expect(kept[0].title).toBe("Story 249");
  // Three batches of fifty: 249-200, 149-100, then twenty of the first fifty.
  expect(kept.at(-1)!.title).toBe("Story 30");
});

it("refreshes the feeds someone follows from the worker", async () => {
  // Only these two feeds are followed, so the pass is this test's alone.
  db.exec("DELETE FROM feed_subscriptions");
  const asked: string[] = [];
  restore = withNewsFixture(async (url) => {
    asked.push(url);
    return new Response(url === LOBSTERS_RSS ? lobstersRss : officialRss);
  });
  await call("/social/feeds/hackernews", "PUT", "jo");
  await call("/social/feeds/lobsters", "PUT", "jo");
  // Nobody has opened Social: the worker reads both feeds anyway.
  expect(await refreshDueFeeds()).toBe(2);
  expect(asked.sort()).toEqual([HACKER_NEWS_RSS, LOBSTERS_RSS].sort());
  // Neither is due again, and a second pass reads nothing.
  expect(await refreshDueFeeds()).toBe(0);
  expect(asked).toHaveLength(2);
  // A page is then served without touching the network.
  const { data } = await get("/social", "jo");
  expect(data.stories).toHaveLength(5);
  expect(data.pending).toEqual([]);
  expect(asked).toHaveLength(2);
});

it("drops the stories of a feed nobody follows any more", async () => {
  db.exec("DELETE FROM feed_subscriptions");
  restore = withNewsFixture(async () => new Response(officialRss));
  await call("/social/feeds/hackernews", "PUT", "kit");
  await get("/social", "kit");
  expect(storedFeedStories("hackernews")).toHaveLength(2);
  await call("/social/feeds/hackernews", "DELETE", "kit");
  db.prepare("INSERT INTO feed_reads(owner_id,feed_id,story_id,read_at) VALUES('kit','hackernews','orphan',0)").run();
  db.prepare("INSERT INTO feed_watches(id,owner_id,query,created_at,since_at) VALUES('orphan-watch','kit','build',0,0)").run();
  db.prepare("INSERT INTO feed_watch_hits(watch_id,feed_id,story_id,matched_at) VALUES('orphan-watch','hackernews','orphan',0)").run();
  // Kept for a month in case it is added back, then dropped.
  expect(forgetAbandoned(Date.now())).toBe(0);
  expect(forgetAbandoned(Date.now() + 31 * 24 * 60 * 60_000)).toBe(1);
  expect(storedFeedStories("hackernews")).toHaveLength(0);
  expect(db.prepare("SELECT * FROM feed_reads WHERE feed_id='hackernews'").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM feed_watch_hits WHERE feed_id='hackernews'").all()).toEqual([]);
});

it("remembers what you have read, per owner", async () => {
  restore = withNewsFixture(async () => new Response(officialRss));
  for (const owner of ["lena", "milo"])
    await call("/social/feeds/hackernews", "PUT", owner);
  const first = await get("/social", "lena");
  expect(first.data.unread).toBe(2);
  expect(first.data.stories.map((s: any) => s.read)).toEqual([false, false]);
  const id = first.data.stories[0].id;
  const marked = await send("/social/read", "POST", { stories: ["unknown:gone", id, "hackernews:missing"] }, "lena");
  expect(marked.data).toEqual({ unread: 1 });
  // Profile badges read the same owner-scoped stored count without loading stories.
  expect((await get("/social/unread", "lena")).data).toEqual({ unread: 1 });
  expect((await get("/social/unread", "milo")).data).toEqual({ unread: 2 });
  expect((await get("/social/unread", "no-feeds")).data).toEqual({ unread: 0 });
  const after = await get("/social", "lena");
  expect(after.data.stories.find((s: any) => s.id === id).read).toBe(true);
  // Only unread, when that is what was asked for.
  const only = await get("/social?unread=1", "lena");
  expect(only.data.stories.map((s: any) => s.id)).not.toContain(id);
  // Reading is yours: the other owner's list is untouched.
  expect((await get("/social", "milo")).data.unread).toBe(2);
  // Marking it unread again brings it back.
  await send("/social/read", "DELETE", { stories: ["unknown:gone", id, "hackernews:missing"] }, "lena");
  expect((await get("/social", "lena")).data.unread).toBe(2);
  // "Mark all read" is one write, and covers everything listed so far.
  expect((await send("/social/read-all", "POST", {}, "lena")).data).toEqual({
    unread: 0,
  });
  expect(
    (await get("/social", "lena")).data.stories.every((s: any) => s.read),
  ).toBe(true);
  expect((await get("/social", "milo")).data.unread).toBe(2);
});

it("removes a swiped-away story, per owner, until it is brought back", async () => {
  restore = withNewsFixture(async () => new Response(officialRss));
  for (const owner of ["ruth", "sami"])
    await call("/social/feeds/hackernews", "PUT", owner);
  const first = await get("/social", "ruth");
  expect(first.data.unread).toBe(2);
  const id = first.data.stories[0].id;
  const removed = await send("/social/dismiss", "POST", { stories: ["unknown:gone", id] }, "ruth");
  expect(removed.data).toEqual({ unread: 1 });
  const after = await get("/social", "ruth");
  expect(after.data.stories.map((s: any) => s.id)).not.toContain(id);
  expect(after.data.unread).toBe(1);
  // Search reaches the whole store, but not what you removed.
  const title = first.data.stories[0].title.split(" ")[0];
  const found = await get(`/social/search?q=${encodeURIComponent(title)}`, "ruth");
  expect(found.data.stories.map((s: any) => s.id)).not.toContain(id);
  // Removing is yours: the other owner still sees it.
  const other = await get("/social", "sami");
  expect(other.data.stories.map((s: any) => s.id)).toContain(id);
  expect(other.data.unread).toBe(2);
  // Undo brings it back.
  await send("/social/dismiss", "DELETE", { stories: [id] }, "ruth");
  const back = await get("/social", "ruth");
  expect(back.data.stories.map((s: any) => s.id)).toContain(id);
  expect(back.data.unread).toBe(2);
});

it("saves a story for later, and keeps it past retention", async () => {
  let payload = officialRss;
  restore = withNewsFixture(async () => new Response(payload));
  await call("/social/feeds/hackernews", "PUT", "nina");
  const { data } = await get("/social", "nina");
  const story = data.stories[0];
  const saved = await laterCall(
    "/later",
    "POST",
    {
      kind: "story",
      targetId: story.id,
      condition: "time",
      dueAt: Date.now() + 3600_000,
    },
    "nina",
  );
  expect(saved.status).toBe(201);
  // A story has no run and no project: it comes back at a time.
  const wrong = await laterCall(
    "/later",
    "POST",
    {
      kind: "story",
      targetId: story.id,
      condition: "run_finished",
    },
    "nina",
  );
  expect(wrong.status).toBe(400);
  // A story of a feed you don't follow is not yours to save.
  const other = await laterCall(
    "/later",
    "POST",
    {
      kind: "story",
      targetId: story.id,
      condition: "time",
      dueAt: Date.now() + 3600_000,
    },
    "owen",
  );
  expect(other.status).toBe(404);
  // It shows in Later with its title and link.
  const listed = await laterCall("/later", "GET", undefined, "nina");
  expect(listed.data.upcoming).toEqual([
    expect.objectContaining({
      kind: "story",
      title: story.title,
      target_id: story.id,
      preview: story.url,
    }),
  ]);
  // A hundred and fifty newer stories arrive, past the hundred and twenty a
  // feed keeps. Everything else of this feed's is evicted; the saved one stays.
  const hackernews = feedById.get("hackernews")!;
  for (let round = 1; round <= 3; round++) {
    payload =
      `<rss version="2.0"><channel><title>Hacker News</title>` +
      Array.from({ length: 50 }, (_, i) => {
        const n = round * 100 + i;
        return `<item><title>Filler ${n}</title><link>https://x.example/f${n}</link><pubDate>${new Date(
          Date.now() + n * 1000,
        ).toUTCString()}</pubDate></item>`;
      }).join("") +
      `</channel></rss>`;
    await feedStories(hackernews, Date.now() + round * 60_000, { force: true });
  }
  const left = storedFeedStories("hackernews");
  expect(left).toHaveLength(121);
  expect(left.some((s) => s.title === story.title)).toBe(true);
  expect(left.some((s) => s.title === "Ask HN: What are you working on?")).toBe(
    false,
  );
});


it("opens a due story reminder inside Social", async () => {
  const { surfaceLater } = await import("../src/server/mobile-return");
  const { seal } = await import("../src/server/secrets");
  const owner = "story-push";
  restore = withNewsFixture(async () => new Response(officialRss));
  await call("/social/feeds/hackernews", "PUT", owner);
  const story = (await get("/social", owner)).data.stories[0];
  const due = Date.now() + 3600_000;
  const subscription = { endpoint: "https://push.example/story", keys: { p256dh: "fixture", auth: "fixture" } };
  db.prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?)").run("story-sub", owner, subscription.endpoint, seal(JSON.stringify(subscription), owner), Date.now());
  const saved = await laterCall("/later", "POST", { kind: "story", targetId: story.id, condition: "time", dueAt: due }, owner);
  expect(saved.status).toBeLessThan(300);
  surfaceLater(due + 1);
  expect(db.prepare("SELECT url FROM push_messages WHERE subscription_id='story-sub'").get()).toEqual({ url: "/?social=" + encodeURIComponent(story.id) });
});

it("retired catalog subscriptions cannot consume the worker refresh batch", async () => {
  db.exec("DELETE FROM feed_subscriptions; DELETE FROM feed_sources; DELETE FROM feed_state");
  const add = db.prepare("INSERT INTO feed_subscriptions(owner_id,feed_id,created_at) VALUES('retired-test',?,0)");
  for (let i = 0; i < 10; i++) add.run(`retired-${i}`);
  for (const feed of feedCatalog.slice(0, 10)) add.run(feed.id);
  const asked: string[] = [];
  restore = withNewsFixture(async url => { asked.push(url); return new Response(officialRss); });
  expect(await refreshDueFeeds()).toBe(8);
  expect(asked).toHaveLength(8);
});
