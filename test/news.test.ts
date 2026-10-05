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
const { news, withNewsFixture, socialStories, feedStories } = await import(
  "../src/server/news"
);
const { feedById, feedCatalog } = await import("../src/shared/news");
const HACKER_NEWS_RSS = feedById.get("hackernews")!.url;
const REDDIT_ATOM = feedById.get("reddit-programming")!.url;

const app = express();
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(news);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function call(path: string, method = "GET", owner = "alice") {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}${path}`,
    { method, headers: { "x-owner": owner } },
  );
  return { status: response.status, data: await response.json() };
}
const get = (path: string, owner?: string) => call(path, "GET", owner);
let restore = () => {};
afterEach(() => restore());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  for (const feed of feedCatalog) expect(feed.url).toMatch(/^https:\/\//);
});

it("adds and removes catalog feeds per owner", async () => {
  expect((await get("/social/feeds", "bob")).data).toEqual({ added: [] });
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
    return new Response(url === REDDIT_ATOM ? redditAtom : officialRss);
  });
  for (const owner of ["dana", "erin"]) {
    await call("/social/feeds/hackernews", "PUT", owner);
    await call("/social/feeds/reddit-programming", "PUT", owner);
  }
  const { status, data } = await get("/social", "dana");
  expect(status).toBe(200);
  expect(data.failed).toEqual([]);
  expect(
    data.stories.map((s: any) => [s.feed, s.title, s.id.split(":")[0]]),
  ).toEqual([
    ["reddit-programming", '"8-pinski" - EIGHT(!) bytes intro for MSDOS', "reddit-programming"],
    ["hackernews", "Run a 125B model at 100T/s & more", "hackernews"],
    ["reddit-programming", "Red, green and mud", "reddit-programming"],
    ["hackernews", "Ask HN: What are you working on?", "hackernews"],
    // Undated stories come last.
    ["reddit-programming", "Sneaky", "reddit-programming"],
  ]);
  // A second owner with the same feeds is served from the same copies.
  await get("/social", "erin");
  expect(asked.sort()).toEqual([HACKER_NEWS_RSS, REDDIT_ATOM].sort());
});

it("keeps the last good copy and names feeds it can't load", async () => {
  let fail = false;
  let calls = 0;
  restore = withNewsFixture(async (url) => {
    calls++;
    if (fail || url === REDDIT_ATOM)
      return new Response("down", { status: 503 });
    return new Response(officialRss);
  });
  await call("/social/feeds/hackernews", "PUT", "frank");
  await call("/social/feeds/reddit-programming", "PUT", "frank");
  const first = await get("/social", "frank");
  expect(first.data.failed).toEqual(["reddit-programming"]);
  expect(first.data.stories).toHaveLength(2);
  // After five minutes Hacker News is refetched; its failure keeps the old list.
  fail = true;
  const later = await socialStories("frank", Date.now() + 6 * 60_000);
  expect(calls).toBe(4);
  expect(later.stories).toHaveLength(2);
  expect(later.failed).toEqual(["reddit-programming"]);
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
  // A document that isn't a feed is remembered the same way.
  answer = () => new Response("<html>Sign in</html>");
  await expect(feedStories(bluesky, at + 3 * 60_000)).rejects.toThrow(
    /isn’t an RSS/,
  );
  await expect(feedStories(bluesky, at + 4 * 60_000)).rejects.toThrow(
    /isn’t an RSS/,
  );
  expect(calls).toBe(2);
  // Once it works again, the stories replace the failure.
  answer = () => new Response(officialRss);
  const fixed = await feedStories(bluesky, at + 6 * 60_000);
  expect(fixed.stories.length).toBeGreaterThan(0);
  expect(calls).toBe(3);
});

it("stops reading a feed as soon as it passes 2 MB", async () => {
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
  await expect(feedStories(bluesky)).rejects.toThrow(/too large/);
  expect(cancelled).toBe(true);
  expect(sent).toBeLessThan(2_500_000);

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
