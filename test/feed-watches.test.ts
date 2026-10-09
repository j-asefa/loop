import { afterAll, afterEach, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "loop-watches-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { errorHandler } = await import("../src/server/error-handler");
const { news, withNewsFixture, socialStories } =
  await import("../src/server/news");
const { saveWatch, matchWatches, previewWatch, feedWatches } =
  await import("../src/server/feed-watches");
const { watchTerms, matchesWatch } = await import("../src/shared/news");
const { db } = await import("../src/server/db");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(news);
app.use(feedWatches);
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

/** A device to push to, so an announced story has somewhere to go. */
function device(owner: string) {
  db.prepare(
    "INSERT INTO push_subscriptions(id,owner_id,endpoint,subscription,created_at) VALUES(?,?,?,'{}',0)",
  ).run(owner + "-device", owner, `https://fcm.googleapis.com/${owner}`);
}
const pushes = (owner: string) =>
  db
    .prepare(
      `SELECT m.message_key,m.title,m.body,m.url FROM push_messages m
       JOIN push_subscriptions s ON s.id=m.subscription_id WHERE s.owner_id=?
       ORDER BY m.rowid`,
    )
    .all(owner) as {
    message_key: string;
    title: string;
    body: string;
    url: string;
  }[];

const feedWith = (titles: string[], at = "Mon, 05 Oct 2026 09:00:00 +0000") =>
  `<rss version="2.0"><channel><title>Hacker News</title>${titles
    .map(
      (title, i) =>
        `<item><title>${title}</title><link>https://example.com/s${i}-${encodeURIComponent(
          title,
        ).slice(0, 20)}</link><pubDate>${at}</pubDate></item>`,
    )
    .join("")}</channel></rss>`;

it("matches whole words, and phrases only as phrases", () => {
  const cases: [string, string, boolean][] = [
    ["ai", "AI safety is hard", true],
    ["ai", "He said nothing", false],
    ["ai", "maintain the build", false],
    ["ai", "The AI, briefly", true],
    ["AI", "ai is lowercase here", true],
    ['"machine learning"', "Machine learning at scale", true],
    ['"machine learning"', "Learning machine basics", false],
    ["claude code", "Claude Code 2.0 ships", true],
    ["claude code", "Claude ships nothing", false],
    ["c++", "C++ 26 is out", true],
    ["rust", "rust-lang news", true],
  ];
  for (const [query, title, want] of cases)
    expect([query, title, matchesWatch(watchTerms(query), { title })]).toEqual([
      query,
      title,
      want,
    ]);
  // A summary counts too, and an empty watch matches nothing.
  expect(
    matchesWatch(watchTerms("kernel"), {
      title: "A post",
      summary: "About the kernel",
    }),
  ).toBe(true);
  expect(matchesWatch(watchTerms("  "), { title: "Anything" })).toBe(false);
});

it("announces a matching story once, and never an older one", async () => {
  db.exec("DELETE FROM feed_subscriptions; DELETE FROM feed_watches");
  device("nell");
  let payload = feedWith(["An old story about Rust"]);
  restore = withNewsFixture(async () => new Response(payload));
  await call("/social/feeds/hackernews", "PUT", undefined, "nell");
  await call("/social", "GET", undefined, "nell");
  // The watch starts now, so what was already here is not a backlog of pushes.
  const watch = saveWatch("nell", { query: "rust" });
  expect(matchWatches()).toBe(0);
  expect(pushes("nell")).toEqual([]);
  // A new story arrives and is announced once, however many passes run.
  payload = feedWith(["Rust in the kernel", "Something else entirely"]);
  await socialStories("nell", Date.now() + 60_000, { force: true, wait: true });
  expect(matchWatches()).toBe(1);
  expect(matchWatches()).toBe(0);
  const sent = pushes("nell");
  expect(sent).toHaveLength(1);
  expect(sent[0].title).toBe("“rust” · Hacker News");
  expect(sent[0].body).toBe("Rust in the kernel");
  expect(sent[0].url).toMatch(/^\/\?social=hackernews/);
  expect(
    db
      .prepare("SELECT count(*) n FROM feed_watch_hits WHERE watch_id=?")
      .get(watch.id),
  ).toEqual({ n: 1 });
});

it("never pushes more than three an hour for one watch", async () => {
  db.exec("DELETE FROM feed_subscriptions; DELETE FROM feed_watches");
  device("omar");
  let payload = feedWith(["Nothing here"]);
  restore = withNewsFixture(async () => new Response(payload));
  await call("/social/feeds/hackernews", "PUT", undefined, "omar");
  await call("/social", "GET", undefined, "omar");
  saveWatch("omar", { query: "rust" });
  payload = feedWith(
    Array.from({ length: 8 }, (_, i) => `Rust story number ${i}`),
  );
  await socialStories("omar", Date.now() + 60_000, { force: true, wait: true });
  expect(matchWatches()).toBe(3);
  const sent = pushes("omar");
  // Three stories, then one line saying how many more matched.
  expect(sent).toHaveLength(4);
  expect(sent.at(-1)!.body).toBe("5 more stories matched.");
  // The rest are recorded, so they are never announced later as a flood.
  expect(db.prepare("SELECT count(*) n FROM feed_watch_hits").get()).toEqual({
    n: 8,
  });
  expect(matchWatches()).toBe(0);
});

it("keeps watches to the feeds their owner follows", async () => {
  db.exec("DELETE FROM feed_subscriptions; DELETE FROM feed_watches");
  device("pavel");
  device("remy");
  restore = withNewsFixture(async () => new Response(feedWith(["Rust rises"])));
  await call("/social/feeds/hackernews", "PUT", undefined, "pavel");
  await call("/social", "GET", undefined, "pavel");
  // Remy follows nothing, so their watch has nothing to match.
  saveWatch("remy", { query: "rust" });
  expect(matchWatches()).toBe(0);
  expect(pushes("remy")).toEqual([]);
  // And a watch cannot name a feed its owner does not follow.
  expect(() =>
    saveWatch("remy", { query: "rust", feeds: ["hackernews"] }),
  ).toThrow(/No such feed/);
});

it("previews a watch without creating or announcing anything", async () => {
  db.exec("DELETE FROM feed_subscriptions; DELETE FROM feed_watches");
  device("sara");
  restore = withNewsFixture(
    async () => new Response(feedWith(["Rust in the kernel", "A CSS trick"])),
  );
  await call("/social/feeds/hackernews", "PUT", undefined, "sara");
  await call("/social", "GET", undefined, "sara");
  const shown = previewWatch("sara", { query: "rust" });
  expect(shown.stories.map((s) => s.title)).toEqual(["Rust in the kernel"]);
  expect(db.prepare("SELECT count(*) n FROM feed_watches").get()).toEqual({
    n: 0,
  });
  expect(pushes("sara")).toEqual([]);
  // Through the route, too.
  const route = await call(
    "/social/watches/preview",
    "POST",
    { query: "css" },
    "sara",
  );
  expect(route.data.stories).toHaveLength(1);
  // A watch needs a word.
  const empty = await call("/social/watches", "POST", { query: '" "' }, "sara");
  expect(empty.status).toBe(400);
});

it("works through a backlog larger than one pass instead of sticking", async () => {
  db.exec("DELETE FROM feed_subscriptions; DELETE FROM feed_watches");
  device("tariq");
  let payload = feedWith(["Nothing yet"]);
  restore = withNewsFixture(async () => new Response(payload));
  await call("/social/feeds/hackernews", "PUT", undefined, "tariq");
  await call("/social", "GET", undefined, "tariq");
  saveWatch("tariq", { query: "rust" });
  // A hundred and twenty matching stories are stored, fifty at a time: more
  // than one pass looks at. Earlier, the limit was applied before announced
  // stories were excluded, so every later pass re-examined the same newest
  // fifty and the rest were never reached.
  const at = Date.now();
  for (let round = 0; round < 3; round++) {
    payload = feedWith(
      Array.from(
        { length: 50 },
        (_, i) => `Rust story ${String(round * 50 + i).padStart(3, "0")}`,
      ),
    );
    await socialStories("tariq", at + (round + 1) * 60_000, {
      force: true,
      wait: true,
    });
  }
  const stored = (
    db
      .prepare("SELECT count(*) n FROM feed_stories WHERE feed_id='hackernews'")
      .get() as { n: number }
  ).n;
  // Retention keeps 120 per feed, one of which is the non-matching story the
  // feed opened with, so the passes below are measured against the matches.
  expect(stored).toBeGreaterThan(100);
  const matching = (
    db
      .prepare(
        "SELECT count(*) n FROM feed_stories WHERE feed_id='hackernews' AND title LIKE 'Rust story%'",
      )
      .get() as { n: number }
  ).n;
  expect(matching).toBe(stored - 1);
  const recorded = () =>
    (
      db.prepare("SELECT count(*) n FROM feed_watch_hits").get() as {
        n: number;
      }
    ).n;
  // Each pass reaches fifty further back, until everything stored is covered.
  matchWatches(at);
  expect(recorded()).toBe(50);
  matchWatches(at + 60_000);
  expect(recorded()).toBe(100);
  matchWatches(at + 120_000);
  expect(recorded()).toBe(matching);
  // And then there is nothing left to find.
  matchWatches(at + 180_000);
  expect(recorded()).toBe(matching);
  // Three were announced in the first hour; the rest are recorded so they are
  // never delivered later as a flood, and summarised in one line per hour.
  expect(
    db.prepare("SELECT count(*) n FROM feed_watch_hits WHERE pushed=1").get(),
  ).toEqual({ n: 3 });
  expect(
    pushes("tariq").filter((push) => /more stor/.test(push.body)).length,
  ).toBeGreaterThan(0);
});

it("preserves explicit feed scope when pausing and resuming a watch", async () => {
  const owner = "scoped-watch";
  await call("/social/feeds/hackernews", "PUT", undefined, owner);
  const watch = saveWatch(owner, { query: "rust", feeds: ["hackernews"] });
  for (const enabled of [false, true]) {
    const result = await call(`/social/watches/${watch.id}`, "PATCH", { query: "rust", enabled }, owner);
    expect(result.status).toBe(200);
    expect(JSON.parse(saveWatch(owner, { query: "rust", enabled }, watch.id).feeds!)).toEqual(["hackernews"]);
  }
  expect(saveWatch(owner, { query: "rust", feeds: null }, watch.id).feeds).toBeNull();
});

it("previews matching stories behind fifty newer nonmatches", async () => {
  const owner = "older-preview";
  let payload = feedWith(["Kubernetes storage"]);
  restore = withNewsFixture(async () => new Response(payload));
  await call("/social/feeds/hackernews", "PUT", undefined, owner);
  await socialStories(owner, Date.now(), {wait:true});
  payload = feedWith(Array.from({length:50}, (_,i) => `New unrelated headline ${i}`));
  await socialStories(owner, Date.now()+60000, {force:true,wait:true});
  const result = await call("/social/watches/preview", "POST", {query:"kubernetes"}, owner);
  expect(result.data.stories.map((story: any) => story.title)).toContain("Kubernetes storage");
});
