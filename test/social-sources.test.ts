import { afterAll, afterEach, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-sources-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { errorHandler } = await import("../src/server/error-handler");
const { news, withNewsFixture } = await import("../src/server/news");
const { sourceId } = await import("../src/server/feed-sources");
const { feedUrl } = await import("../src/server/feed-fetch");

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(news);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function call(
  path: string,
  method = "GET",
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
  const text = await response.text();
  return {
    status: response.status,
    data: text && text.startsWith("{") ? JSON.parse(text) : text,
  };
}
let restore = () => {};
afterEach(() => restore());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const blogAtom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Julia Evans</title><link rel="alternate" href="https://jvns.ca/"/>
<entry><title>How DNS works</title><link href="https://jvns.ca/dns"/><id>tag:jvns,1</id><updated>2026-10-05T09:00:00Z</updated></entry>
<entry><title>Debugging</title><link href="https://jvns.ca/debug"/><id>tag:jvns,2</id><updated>2026-10-04T09:00:00Z</updated></entry>
</feed>`;

// An address someone typed is checked before it is ever requested. Each of
// these is refused without a socket being opened.
it("refuses an address Loop must not request", () => {
  const refused: [string, RegExp][] = [
    ["http://jvns.ca/atom.xml", /https/i],
    ["https://user:pass@jvns.ca/atom.xml", /username or password/i],
    ["https://localhost/feed", /this network/i],
    ["https://anything.localhost/feed", /this network/i],
    ["https://printer.local/feed", /this network/i],
    ["https://metadata.internal/feed", /this network/i],
    ["https://127.0.0.1/feed", /this network/i],
    ["https://169.254.169.254/latest/meta-data/", /this network/i],
    ["https://10.1.2.3/feed", /this network/i],
    ["https://192.168.0.1/feed", /this network/i],
    ["https://[::1]/feed", /this network/i],
    ["ftp://jvns.ca/atom.xml", /https/i],
    ["not a url", /feed address/i],
    ["https://jvns.ca/" + "x".repeat(2100), /too long/i],
  ];
  for (const [address, why] of refused)
    expect(() => feedUrl(address), address).toThrow(why);
  // A public address is allowed, and its fragment is dropped.
  expect(feedUrl("https://jvns.ca/atom.xml#top").href).toBe(
    "https://jvns.ca/atom.xml",
  );
});

it("refuses an address Loop must not request, through the route too", async () => {
  let asked = 0;
  restore = withNewsFixture(async () => {
    asked++;
    return new Response(blogAtom);
  });
  for (const url of ["http://jvns.ca/atom.xml", "https://127.0.0.1/feed"]) {
    const refused = await call("/social/sources", "PUT", { url });
    expect(refused.status).toBe(400);
  }
  // Nothing was requested on the way to refusing them.
  expect(asked).toBe(0);
});

it("adds a feed by address, shares its stories, and removes it", async () => {
  const asked: string[] = [];
  restore = withNewsFixture(async (url) => {
    asked.push(url);
    return new Response(blogAtom);
  });
  const added = await call(
    "/social/sources",
    "PUT",
    { url: "https://jvns.ca/atom.xml" },
    "pia",
  );
  expect(added.status).toBe(201);
  expect(added.data).toMatchObject({
    id: sourceId(new URL("https://jvns.ca/atom.xml")),
    name: "Julia Evans",
    home: "jvns.ca",
    category: "Your feeds",
  });
  const listed = await call("/social/feeds", "GET", undefined, "pia");
  expect(listed.data.own).toHaveLength(1);
  const shown = await call("/social", "GET", undefined, "pia");
  expect(shown.data.stories.map((s: any) => s.title)).toEqual([
    "How DNS works",
    "Debugging",
  ]);
  // A second owner adding the same address shares the one stored copy.
  asked.length = 0;
  await call(
    "/social/sources",
    "PUT",
    { url: "https://jvns.ca/atom.xml" },
    "quin",
  );
  const other = await call("/social", "GET", undefined, "quin");
  expect(other.data.stories).toHaveLength(2);
  // Removing it is per owner: the other owner still has it.
  const removed = await call(
    `/social/sources/${added.data.id}`,
    "DELETE",
    undefined,
    "pia",
  );
  expect(removed.data.own).toEqual([]);
  expect((await call("/social", "GET", undefined, "pia")).data.stories).toEqual(
    [],
  );
  expect(
    (await call("/social", "GET", undefined, "quin")).data.stories,
  ).toHaveLength(2);
});

it("offers the feeds a page advertises when the address is a site", async () => {
  restore = withNewsFixture(async (url) => {
    if (url === "https://jvns.ca/")
      return new Response(
        `<html><head><title>Julia</title>
        <link rel="alternate" type="application/rss+xml" title="Posts" href="/atom.xml">
        <link rel="alternate" type="application/feed+json" href="https://jvns.ca/feed.json">
        <link rel="alternate" type="application/rss+xml" href="http://jvns.ca/insecure.xml">
        <link rel="stylesheet" href="/style.css"></head><body>Hi</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    return new Response(blogAtom);
  });
  const found = await call("/social/sources/discover", "POST", {
    url: "https://jvns.ca/",
  });
  // Resolved absolute, and the insecure one is not offered.
  expect(found.data.candidates).toEqual([
    { url: "https://jvns.ca/atom.xml", title: "Posts" },
    { url: "https://jvns.ca/feed.json", title: "jvns.ca" },
  ]);
  // An address that is itself a feed comes back as the one candidate.
  const direct = await call("/social/sources/discover", "POST", {
    url: "https://jvns.ca/atom.xml",
  });
  expect(direct.data.candidates).toEqual([
    { url: "https://jvns.ca/atom.xml", title: "Julia Evans" },
  ]);
});

it("imports and exports OPML without reading a feed", async () => {
  let asked = 0;
  restore = withNewsFixture(async () => {
    asked++;
    return new Response(blogAtom);
  });
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="Engineering">
      <outline type="rss" text="Julia Evans" xmlUrl="https://jvns.ca/atom.xml"/>
      <outline type="rss" text="Go" xmlUrl="https://go.dev/blog/feed.atom"/>
      <outline type="rss" text="Again" xmlUrl="https://jvns.ca/atom.xml"/>
      <outline type="rss" text="Local" xmlUrl="http://192.168.1.1/feed"/>
      <outline text="A folder with no feed"/>
    </outline></body></opml>`;
  const imported = await call("/social/opml", "POST", { opml }, "rex");
  expect(imported.data.added).toBe(2);
  expect(imported.data.skipped).toEqual([
    { url: "https://jvns.ca/atom.xml", reason: "Already added." },
    expect.objectContaining({ url: "http://192.168.1.1/feed" }),
  ]);
  // Three hundred feeds would otherwise be three hundred requests.
  expect(asked).toBe(0);
  // Exported, it parses back through the import path to the same feeds.
  const exported = await call("/social/opml", "GET", undefined, "rex");
  expect(exported.data).toContain("https://jvns.ca/atom.xml");
  const round = await call(
    "/social/opml",
    "POST",
    { opml: exported.data },
    "sam",
  );
  expect(round.data.added).toBe(2);
});

it("will not let a feed address collide with the catalog", async () => {
  const { feedCatalog } = await import("../src/shared/news");
  restore = withNewsFixture(async () => new Response(blogAtom));
  // Ids are prefixed, so no address can ever produce a catalog id.
  for (const feed of feedCatalog)
    expect(feed.id.startsWith("user:")).toBe(false);
  expect(sourceId(new URL("https://jvns.ca/atom.xml"))).toMatch(
    /^user:[0-9a-f]{32}$/,
  );
});

it("refuses an OPML document that is too large", async () => {
  const huge = "x".repeat(1_100_000);
  const refused = await call("/social/opml", "POST", { opml: huge });
  expect(refused.status).toBe(400);
});

it("reads and saves a story from a feed you added yourself", async () => {
  // A custom feed's id already contains a colon ("user:<hash>"), so a story
  // key is "user:<hash>:<story>"; splitting at the first colon resolved the
  // feed as "user" and silently dropped the mark.
  restore = withNewsFixture(async () => new Response(blogAtom));
  const added = await call(
    "/social/sources",
    "PUT",
    { url: "https://jvns.ca/atom.xml" },
    "tess",
  );
  expect(added.data.id).toMatch(/^user:/);
  const page = await call("/social", "GET", undefined, "tess");
  const story = page.data.stories[0];
  expect(story.id.startsWith(added.data.id + ":")).toBe(true);
  expect(page.data.unread).toBe(2);
  const marked = await call(
    "/social/read",
    "POST",
    { stories: [story.id] },
    "tess",
  );
  expect(marked.data).toEqual({ unread: 1 });
  const after = await call("/social", "GET", undefined, "tess");
  expect(after.data.stories.find((s: any) => s.id === story.id).read).toBe(
    true,
  );
  // And the same id is the one Later saves.
  const { savedStory } = await import("../src/server/news");
  expect(savedStory("tess", story.id)).toMatchObject({ title: story.title });
  // A story id that names no followed feed is not found.
  expect(savedStory("tess", "user:nope:1")).toBe(null);
});

it("reads a story from an OPML-imported feed", async () => {
  restore = withNewsFixture(async () => new Response(blogAtom));
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline type="rss" text="Julia Evans" xmlUrl="https://jvns.ca/atom.xml"/>
  </body></opml>`;
  expect((await call("/social/opml", "POST", { opml }, "ula")).data.added).toBe(
    1,
  );
  const page = await call("/social", "GET", undefined, "ula");
  const story = page.data.stories[0];
  expect(
    (await call("/social/read", "POST", { stories: [story.id] }, "ula")).data,
  ).toEqual({ unread: 1 });
});

it("refuses a discovery redirect that points inside this network", async () => {
  const asked: string[] = [];
  restore = withNewsFixture(async (url) => {
    asked.push(url);
    // A public page that redirects discovery at something local.
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:9/feed" },
    });
  });
  const refused = await call("/social/sources/discover", "POST", {
    url: "https://jvns.ca/",
  });
  expect(refused.status).toBe(400);
  expect(refused.data.error ?? refused.data.detail ?? refused.data).toMatch(
    /this network|https/i,
  );
  // Discovery tries the address as a feed and then as a page; neither
  // request followed the redirect to the private address.
  expect(new Set(asked)).toEqual(new Set(["https://jvns.ca/"]));
});


it("re-adds an existing source idempotently even at the subscription limit", async () => {
  const { addSource } = await import("../src/server/feed-sources");
  const { db } = await import("../src/server/db");
  let downloads = 0;
  restore = withNewsFixture(async () => { downloads++; return new Response(blogAtom); });
  const entry = await addSource("full-owner", { url: "https://jvns.ca/atom.xml", title: "Original" });
  const row = db.prepare("SELECT * FROM feed_sources WHERE owner_id='full-owner'").get() as any;
  for (let i = 0; i < 199; i++) db.prepare("INSERT INTO feed_sources(id,owner_id,url,title,home,category,kind,color,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("extra-" + i, row.owner_id, "https://example.com/" + i, row.title, row.home, row.category, row.kind, row.color, row.created_at);
  expect(await addSource("full-owner", { url: entry.url, title: "Different" })).toEqual(entry);
  expect(downloads).toBe(1);
});

it("imports every nested outline with explicit closing tags", async () => {
  const opml = '<opml><body><outline text="Tech"><outline text="A" xmlUrl="https://a.example/feed"></outline><outline text="Nested"><outline text="B" xmlUrl="https://b.example/feed"/></outline><outline text="C > D" xmlUrl="https://c.example/feed"></outline></outline></body></opml>';
  const result = await call("/social/opml", "POST", { opml }, "explicit-outlines");
  expect(result.status).toBe(200);
  expect(result.data.added).toBe(3);
  expect(result.data.skipped).toEqual([]);
});

it("bounds malformed OPML comment scanning at the HTTP boundary", async () => {
  const start = performance.now();
  const result = await call("/social/opml", "POST", { opml: "<!--".repeat(250000) }, "comment-scan");
  expect(result.status).toBe(200);
  expect(result.data.added).toBe(0);
  expect(performance.now() - start).toBeLessThan(2000);
});

it("discovers feeds in the head of a large declared page", async () => {
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head>' + "x".repeat(700000);
  restore = withNewsFixture(async () => new Response(html, { headers: { "content-length": String(html.length) } }));
  const result = await call("/social/sources/discover", "POST", {url:"https://large.example/"});
  expect(result.status).toBe(200);
  expect(result.data.candidates).toContainEqual({url:"https://large.example/feed",title:"large.example"});
});

it("exposes useful feed refusal reasons through the production error handler", async () => {
  restore = withNewsFixture(async () => new Response("<html>Not a feed</html>"));
  const result = await call("/social/sources", "PUT", {url:"https://bad.example/feed"});
  expect(result.status).toBe(400);
  expect(result.data.error).toMatch(/isn’t an RSS/);
  restore();
  restore = withNewsFixture(async () => new Response(null, {status:302,headers:{location:"https://bad.example/login"}}));
  const login = await call("/social/sources", "PUT", {url:"https://bad.example/feed"});
  expect(login.status).toBe(400);
  expect(login.data.error).toMatch(/needs an account/);
});
