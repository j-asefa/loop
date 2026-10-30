import { afterAll, afterEach, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop55-browse-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { errorHandler } = await import("../src/server/error-handler");
const { parseFeed } = await import("../src/server/syndication");
const { news, withNewsFixture, feedStories } =
  await import("../src/server/news");
const { feedById } = await import("../src/shared/news");
const { db } = await import("../src/server/db");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(news);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const call = async (
  path: string,
  method = "GET",
  body?: unknown,
  owner = "alice",
) => {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}${path}`,
    {
      method,
      headers: { "x-owner": owner, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: response.status, data: await response.json() };
};
let restore = () => {};
afterEach(() => restore());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

it("reads the picture and the audio or video a feed offered", () => {
  const rss = parseFeed(
    `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:itunes="x"><channel><title>Pod</title><link>https://pod.example/</link>
<item><title>Episode one</title><link>https://pod.example/1</link><enclosure url="https://pod.example/1.mp3" type="audio/mpeg" length="1000"/><itunes:duration>1860</itunes:duration><media:thumbnail url="https://pod.example/1.jpg"/></item>
<item><title>With an image enclosure</title><link>https://pod.example/2</link><enclosure url="https://pod.example/2.png" type="image/png"/></item>
<item><title>Insecure picture</title><link>https://pod.example/3</link><media:thumbnail url="http://pod.example/3.jpg"/></item>
<item><title>Sneaky picture</title><link>https://pod.example/4</link><media:content url="javascript:alert(1)" medium="image"/></item>
<item><title>From the body</title><link>https://pod.example/5</link><description>&lt;p&gt;Hi &lt;img src="https://pod.example/5.webp"&gt;&lt;/p&gt;</description></item>
</channel></rss>`,
    "https://pod.example/rss",
  ).stories;
  expect(rss.map((s) => [s.title, s.image, s.media])).toEqual([
    [
      "Episode one",
      "https://pod.example/1.jpg",
      { url: "https://pod.example/1.mp3", type: "audio/mpeg", seconds: 1860 },
    ],
    ["With an image enclosure", "https://pod.example/2.png", null],
    // An http picture on an https page is a broken box, so it is dropped.
    ["Insecure picture", null, null],
    ["Sneaky picture", null, null],
    ["From the body", "https://pod.example/5.webp", null],
  ]);
});

it("reads a video feed's picture, length and description", () => {
  // The shape YouTube serves: Atom with a media:group per entry.
  const feed = parseFeed(
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<title>Channel</title><link rel="alternate" href="https://www.youtube.com/channel/x"/>
<entry><id>yt:video:1</id><title>How DNS works</title><link rel="alternate" href="https://www.youtube.com/watch?v=1"/><published>2026-10-05T09:00:00Z</published>
<media:group><media:title>How DNS works</media:title><media:content url="https://www.youtube.com/v/1" type="application/x-shockwave-flash"/><media:thumbnail url="https://i.ytimg.com/vi/1/hq.jpg" width="480" height="360"/><media:description>A walk through resolvers.</media:description></media:group></entry>
</feed>`,
    "https://www.youtube.com/feeds/videos.xml?channel_id=x",
  ).stories;
  expect(feed).toEqual([
    expect.objectContaining({
      title: "How DNS works",
      url: "https://www.youtube.com/watch?v=1",
      image: "https://i.ytimg.com/vi/1/hq.jpg",
      summary: "A walk through resolvers.",
    }),
  ]);
});

it("reads a JSON feed's image and attachment", () => {
  const stories = parseFeed(
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "JSON",
      home_page_url: "https://json.example/",
      items: [
        {
          id: "1",
          url: "https://json.example/1",
          title: "An episode",
          image: "https://json.example/1.jpg",
          attachments: [
            {
              url: "https://json.example/1.mp3",
              mime_type: "audio/mpeg",
              duration_in_seconds: 600,
            },
          ],
        },
      ],
    }),
    "https://json.example/feed.json",
  ).stories;
  expect(stories[0]).toMatchObject({
    image: "https://json.example/1.jpg",
    media: {
      url: "https://json.example/1.mp3",
      type: "audio/mpeg",
      seconds: 600,
    },
  });
});

// Lobsters rather than Hacker News: HN's descriptions are only links back to
// the discussion, so the parser blanks them and there is no summary to search.
const rss = (titles: [string, string][]) =>
  `<rss version="2.0"><channel><title>Lobsters</title><link>https://lobste.rs/</link>${titles
    .map(
      ([title, summary], i) =>
        `<item><title>${title}</title><link>https://example.com/b${i}</link><description>${summary}</description><pubDate>Mon, 0${
          (i % 5) + 1
        } Oct 2026 09:00:00 +0000</pubDate></item>`,
    )
    .join("")}</channel></rss>`;

it("searches further back than the page shows", async () => {
  db.exec("DELETE FROM feed_subscriptions");
  restore = withNewsFixture(
    async () =>
      new Response(
        rss([
          ["Postgres indexes explained", "B-trees and when they help"],
          ["A note on Rust", "Ownership, briefly"],
          ["Unrelated", "Nothing to see"],
        ]),
      ),
  );
  await call("/social/feeds/lobsters", "PUT", undefined, "tam");
  await call("/social", "GET", undefined, "tam");
  const hits = await call("/social/search?q=postgres", "GET", undefined, "tam");
  expect(hits.data.stories.map((s: any) => s.title)).toEqual([
    "Postgres indexes explained",
  ]);
  // The summary is searched too, not just the title.
  expect(
    (
      await call("/social/search?q=ownership", "GET", undefined, "tam")
    ).data.stories.map((s: any) => s.title),
  ).toEqual(["A note on Rust"]);
  // Several words mean all of them.
  expect(
    (await call("/social/search?q=postgres+rust", "GET", undefined, "tam")).data
      .stories,
  ).toEqual([]);
  // A story of a feed you don't follow is never returned.
  expect(
    (await call("/social/search?q=postgres", "GET", undefined, "una")).data
      .stories,
  ).toEqual([]);
  // A feed filter must be one of yours.
  expect(
    (
      await call(
        "/social/search?q=postgres&feed=hackernews",
        "GET",
        undefined,
        "tam",
      )
    ).status,
  ).toBe(404);
  // Query punctuation is not FTS syntax.
  expect(
    (await call('/social/search?q=postgres OR "', "GET", undefined, "tam"))
      .status,
  ).toBe(200);
});

it("keeps the search index in step with the stories", async () => {
  db.exec("DELETE FROM feed_subscriptions");
  let payload = rss([
    ["Kept story", "stays"],
    ["Dropped story", "goes"],
  ]);
  restore = withNewsFixture(async () => new Response(payload));
  await call("/social/feeds/lobsters", "PUT", undefined, "vera");
  await call("/social", "GET", undefined, "vera");
  const indexed = () =>
    (db.prepare("SELECT count(*) n FROM feed_search").get() as { n: number }).n;
  expect(indexed()).toBe(2);
  // Re-reading the same stories does not duplicate them in the index.
  await feedStories(feedById.get("lobsters")!, Date.now() + 60_000, {
    force: true,
  });
  expect(indexed()).toBe(2);
  // A story that retention drops leaves the index with it.
  db.prepare(
    "DELETE FROM feed_stories WHERE feed_id='lobsters' AND title='Dropped story'",
  ).run();
  expect(indexed()).toBe(1);
  expect(
    (await call("/social/search?q=dropped", "GET", undefined, "vera")).data
      .stories,
  ).toEqual([]);
});

it("hides muted words, counts them, and shows them on request", async () => {
  db.exec("DELETE FROM feed_subscriptions");
  restore = withNewsFixture(
    async () =>
      new Response(
        rss([
          ["Crypto is back", "Again"],
          ["A CSS trick", "Useful"],
          ["Nothing about cryptography", "Not the same word"],
        ]),
      ),
  );
  await call("/social/feeds/lobsters", "PUT", undefined, "wyn");
  await call("/social", "GET", undefined, "wyn");
  const muted = await call(
    "/social/mutes",
    "POST",
    { phrase: "crypto" },
    "wyn",
  );
  expect(muted.data.mutes).toEqual(["crypto"]);
  const page = await call("/social", "GET", undefined, "wyn");
  // Whole words: "cryptography" is not "crypto".
  expect(page.data.stories.map((s: any) => s.title)).toEqual([
    "Nothing about cryptography",
    "A CSS trick",
  ]);
  expect(page.data.hidden).toBe(1);
  expect(page.data.unread).toBe(2);
  const shown = await call("/social?muted=1", "GET", undefined, "wyn");
  expect(shown.data.stories).toHaveLength(3);
  expect(shown.data.hidden).toBe(0);
  // Searching for a muted word still finds it: you meant it. Search matches
  // prefixes, unlike a mute, which is whole words only.
  expect(
    (
      await call("/social/search?q=crypto", "GET", undefined, "wyn")
    ).data.stories
      .map((s: any) => s.title)
      .sort(),
  ).toEqual(["Crypto is back", "Nothing about cryptography"]);
  // And unmuting brings it back.
  const back = await call(
    "/social/mutes",
    "DELETE",
    { phrase: "crypto" },
    "wyn",
  );
  expect(back.data.mutes).toEqual([]);
  expect(
    (await call("/social", "GET", undefined, "wyn")).data.stories,
  ).toHaveLength(3);
});

it("keeps feed pictures off until they are turned on", async () => {
  const off = await call("/social/preferences", "GET", undefined, "xena");
  expect(off.data).toEqual({ agent_access: false, images: false, mutes: [] });
  const on = await call("/social/preferences", "PUT", { images: true }, "xena");
  expect(on.data).toMatchObject({ images: true, agent_access: false });
});

it("lets an explicit unread mark outlive mark-all-read", async () => {
  db.exec("DELETE FROM feed_subscriptions");
  restore = withNewsFixture(
    async () =>
      new Response(
        rss([
          ["First", "one"],
          ["Second", "two"],
        ]),
      ),
  );
  await call("/social/feeds/lobsters", "PUT", undefined, "yves");
  const page = await call("/social", "GET", undefined, "yves");
  const story = page.data.stories[0];
  expect((await call("/social/read-all", "POST", {}, "yves")).data).toEqual({
    unread: 0,
  });
  // Marking one story unread again has to survive a reload: there is no read
  // row to delete, only the watermark that covered it.
  const back = await call(
    "/social/read",
    "DELETE",
    { stories: [story.id] },
    "yves",
  );
  expect(back.data).toEqual({ unread: 1 });
  const after = await call("/social", "GET", undefined, "yves");
  expect(after.data.unread).toBe(1);
  expect(after.data.stories.find((s: any) => s.id === story.id).read).toBe(
    false,
  );
  expect(
    (await call("/social?unread=1", "GET", undefined, "yves")).data.stories.map(
      (s: any) => s.id,
    ),
  ).toEqual([story.id]);
  // And reading it again sticks too.
  await call("/social/read", "POST", { stories: [story.id] }, "yves");
  expect((await call("/social", "GET", undefined, "yves")).data.unread).toBe(0);
});

it("serves a feed's picture through Loop55, not from the publisher", async () => {
  db.exec("DELETE FROM feed_subscriptions");
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
    "hex",
  );
  const asked: string[] = [];
  restore = withNewsFixture(async (url) => {
    asked.push(url);
    if (url.endsWith(".png"))
      return new Response(png, { headers: { "content-type": "image/png" } });
    if (url.endsWith(".svg"))
      return new Response("<svg/>", {
        headers: { "content-type": "image/svg+xml" },
      });
    return new Response(
      `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Lobsters</title><link>https://lobste.rs/</link>
<item><title>With a picture</title><link>https://example.com/p1</link><media:thumbnail url="https://pics.example/a.png"/></item>
<item><title>With a drawing</title><link>https://example.com/p2</link><media:thumbnail url="https://pics.example/b.svg"/></item>
<item><title>With none</title><link>https://example.com/p3</link></item>
</channel></rss>`,
    );
  });
  await call("/social/feeds/lobsters", "PUT", undefined, "zara");
  const page = await call("/social", "GET", undefined, "zara");
  const [picture, drawing, none] = page.data.stories;
  const image = async (story: string) =>
    fetch(
      `http://127.0.0.1:${(server.address() as any).port}/social/image?story=${encodeURIComponent(story)}`,
      { headers: { "x-owner": "zara" } },
    );
  const served = await image(picture.id);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toMatch(/^image\/png/);
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
  // An SVG is a document that can carry script, so it is not served.
  expect((await image(drawing.id)).status).toBe(404);
  expect((await image(none.id)).status).toBe(404);
  // Nor is a story of a feed you do not follow.
  const other = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/social/image?story=${encodeURIComponent(picture.id)}`,
    { headers: { "x-owner": "aled" } },
  );
  expect(other.status).toBe(404);
});

it("cancels a chunked image as soon as it exceeds the byte budget", async () => {
  db.exec("DELETE FROM feed_subscriptions");
  let chunks = 0;
  let cancelled = false;
  restore = withNewsFixture(async (url) => {
    if (url.endsWith(".png"))
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (chunks === 20) return controller.close();
              chunks++;
              controller.enqueue(new Uint8Array(1_000_000));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "image/png" } },
      );
    return new Response(`<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
      <item><title>Oversized picture</title><link>https://example.com/large</link>
      <media:thumbnail url="https://pics.example/large.png"/></item>
      </channel></rss>`);
  });
  await call("/social/feeds/lobsters", "PUT", undefined, "image-budget");
  const page = await call("/social", "GET", undefined, "image-budget");
  const story = page.data.stories[0].id;
  const result = await call(
    `/social/image?story=${encodeURIComponent(story)}`,
    "GET",
    undefined,
    "image-budget",
  );
  expect(result.status).toBe(413);
  expect(chunks).toBe(6);
  expect(cancelled).toBe(true);
});

it("rejects insecure JSON Feed image attachments", () => {
  const parsed = parseFeed(
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "Feed",
      items: [
        {
          id: "one",
          url: "https://example.com/one",
          title: "One",
          attachments: [
            { mime_type: "image/png", url: "http://example.com/picture.png" },
          ],
        },
        {
          id: "two",
          url: "https://example.com/two",
          title: "Two",
          attachments: [
            { mime_type: "image/png", url: "https://example.com/picture.png" },
          ],
        },
      ],
    }),
    "https://example.com/feed",
  );
  expect(parsed.stories.map((story) => story.image)).toEqual([
    null,
    "https://example.com/picture.png",
  ]);
});

it("counts the same unread article once across followed feeds", async () => {
  restore = withNewsFixture(
    async () => new Response(rss([["Shared story", "Summary"]])),
  );
  expect(
    (await call("/social/feeds/lobsters", "PUT", undefined, "duplicate-reader"))
      .status,
  ).toBe(200);
  expect(
    (
      await call(
        "/social/feeds/hackernews",
        "PUT",
        undefined,
        "duplicate-reader",
      )
    ).status,
  ).toBe(200);
  const page = await call(
    "/social?unread=1",
    "GET",
    undefined,
    "duplicate-reader",
  );
  expect(page.data.stories).toHaveLength(1);
  expect(page.data.unread).toBe(1);
});
