import { afterAll, afterEach, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseEmission, eventScopes } from "../src/shared/workspace-events";

const dir = mkdtempSync(join(tmpdir(), "loop-feed-agent-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { errorHandler } = await import("../src/server/error-handler");
const {
  news,
  withNewsFixture,
  feedForAgent,
  setFeedPreferences,
  forgetCachedStories,
} = await import("../src/server/news");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools");
const {
  saveDigest,
  runDueDigests,
  dueDigests,
  localTime,
  digestPrompt,
  feedDigests,
} = await import("../src/server/feed-digests");
const { db, id } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { feedById } = await import("../src/shared/news");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(news);
app.use(feedDigests);
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

const rss = `<rss version="2.0"><channel><title>Hacker News</title>
<item><title>A faster build system</title><link>https://example.com/builds</link><pubDate>Mon, 05 Oct 2026 09:00:00 +0000</pubDate><comments>https://news.ycombinator.com/item?id=1</comments><description><![CDATA[<p>Points: 90<br/># Comments: 12]]></description></item>
<item><title>Rust in the kernel</title><link>https://example.com/rust</link><pubDate>Sun, 04 Oct 2026 09:00:00 +0000</pubDate><comments>https://news.ycombinator.com/item?id=2</comments></item>
</channel></rss>`;

/** An owner with one feed read into the store, and an agent to send to. */
async function workspace(owner: string) {
  restore = withNewsFixture(async () => new Response(rss));
  await call("/social/feeds/hackernews", "PUT", undefined, owner);
  await call("/social", "GET", undefined, owner);
  const agent = id();
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,0)",
  ).run(
    connection,
    owner,
    seal("fixture-key", owner),
    JSON.stringify([{ id: "fixture" }]),
  );
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,?,?,?,'openai',?,'fixture',0)",
  ).run(agent, owner, "Scout " + owner, "scout-" + owner, connection);
  return agent;
}

it("keeps the feed from agents until it is turned on", async () => {
  const agent = await workspace("tess");
  const run = {
    id: id(),
    owner_id: "tess",
    agent_id: agent,
    payload: "{}",
  } as any;
  // Off by default: the tool is not even offered.
  expect(nativeBindings(run).map((t) => t.tool)).not.toContain("loop_feed");
  setFeedPreferences("tess", { agent_access: true });
  expect(nativeBindings(run).map((t) => t.tool)).toContain("loop_feed");
  const described = nativeBindings(run).find((t) => t.tool === "loop_feed")!;
  expect(described.description).toMatch(
    /reads only the feeds they already follow/i,
  );
  setFeedPreferences("tess", { agent_access: false });
  expect(nativeBindings(run).map((t) => t.tool)).not.toContain("loop_feed");
  // Calling it anyway is refused: invokeNative only runs a tool that
  // nativeBindings offered for this run.
  await expect(
    invokeNative(run, { ...described }, "call-1", {}),
  ).rejects.toThrow();
});

it("reads only this owner's feeds, and marks nothing read", async () => {
  await workspace("ulla");
  await workspace("vic");
  // Vic follows one feed; Ulla follows the same one. Each sees their own.
  const read = feedForAgent("ulla");
  expect(read.stories.map((s) => s.title)).toEqual([
    "A faster build system",
    "Rust in the kernel",
  ]);
  expect(read.stories[0]).toMatchObject({
    feed: "Hacker News",
    points: 90,
    comments: 12,
    comments_url: "https://news.ycombinator.com/item?id=1",
    read: false,
  });
  expect(read.read_at).toBeGreaterThan(0);
  // Someone who follows nothing sees nothing.
  expect(feedForAgent("wes").stories).toEqual([]);
  // Filters.
  expect(feedForAgent("ulla", { query: "rust" }).stories).toHaveLength(1);
  expect(feedForAgent("ulla", { limit: 1 }).stories).toHaveLength(1);
  expect(
    feedForAgent("ulla", { since: Date.parse("2026-10-05T00:00:00Z") }).stories,
  ).toHaveLength(1);
  expect(() => feedForAgent("ulla", { feedId: "lobsters" })).toThrow(
    /No such feed/,
  );
  // Reading it does not mark anything read.
  expect((await call("/social", "GET", undefined, "ulla")).data.unread).toBe(2);
  const marked = await call(
    "/social/read",
    "POST",
    { stories: [`hackernews:1`] },
    "ulla",
  );
  expect(marked.data.unread).toBe(1);
  expect(feedForAgent("ulla", { unreadOnly: true }).stories).toHaveLength(1);
});

it("sends a digest once a day, in the owner's own zone", async () => {
  const agent = await workspace("xan");
  db.prepare("UPDATE feed_digests SET enabled=0").run();
  const digest = saveDigest("xan", {
    agentId: agent,
    minuteOfDay: 8 * 60,
    zone: "Europe/London",
    unreadOnly: false,
  });
  const before = Date.parse("2026-10-08T06:30:00Z"); // 07:30 in London
  const after = Date.parse("2026-10-08T07:30:00Z"); // 08:30 in London
  // The store normally records arrivals with the wall clock. Keep the fixture
  // on the digest's simulated timeline, regardless of when this suite runs.
  db.prepare(
    "UPDATE feed_stories SET first_seen_at=? WHERE feed_id='hackernews'",
  ).run(before);
  forgetCachedStories();
  expect(dueDigests(before)).toEqual([]);
  expect(dueDigests(after).map((d) => d.id)).toEqual([digest.id]);
  expect(runDueDigests(after)).toBe(1);
  const runs = () =>
    (
      db
        .prepare(
          "SELECT idempotency_key FROM runs WHERE owner_id='xan' ORDER BY created_at",
        )
        .all() as { idempotency_key: string }[]
    ).map((row) => row.idempotency_key);
  expect(runs()).toEqual([`feed-digest:${digest.id}:2026-10-08`]);
  // Not again the same local day, however often the worker passes.
  expect(runDueDigests(after + 3600_000)).toBe(0);
  expect(runDueDigests(after + 8 * 3600_000)).toBe(0);
  expect(runs()).toHaveLength(1);
  // The next day with nothing new sends nothing: a digest covers what has
  // arrived since the last one.
  expect(runDueDigests(after + 24 * 3600_000)).toBe(0);
  expect(runs()).toHaveLength(1);
  // Once something arrives, the next day's digest goes out.
  db.prepare(
    `INSERT INTO feed_stories(feed_id,story_id,url,title,summary,story,published_at,first_seen_at,fetched_at)
     VALUES('hackernews','fresh','https://example.com/fresh','Something new',NULL,?,?,?,?)`,
  ).run(
    JSON.stringify({
      id: "fresh",
      title: "Something new",
      url: "https://example.com/fresh",
      site: null,
      comments_url: null,
      published_at: after + 50 * 3600_000,
      community: null,
      author: null,
      points: null,
      comments: null,
      summary: null,
      image: null,
      media: null,
    }),
    after + 50 * 3600_000,
    after + 50 * 3600_000,
    after + 50 * 3600_000,
  );
  forgetCachedStories();
  expect(runDueDigests(after + 52 * 3600_000)).toBe(1);
  expect(runs()).toHaveLength(2);
});

it("keeps a digest at the same clock time across a daylight change", () => {
  // London leaves summer time on 2026-10-25 at 02:00.
  const summer = Date.parse("2026-10-24T07:30:00Z");
  const winter = Date.parse("2026-10-26T07:30:00Z");
  expect(localTime(summer, "Europe/London").minute).toBe(8 * 60 + 30);
  expect(localTime(winter, "Europe/London").minute).toBe(7 * 60 + 30);
  // A digest at 08:00 is due at 08:30 local on both days, which is a
  // different number of hours after midnight UTC.
  expect(
    localTime(Date.parse("2026-10-26T08:30:00Z"), "Europe/London").minute,
  ).toBe(8 * 60 + 30);
});

it("asks the agent about the stories, not for them", async () => {
  const agent = await workspace("yuri");
  // Earlier tests left their own digests enabled; this counts only this one.
  db.prepare("UPDATE feed_digests SET enabled=0").run();
  const digest = saveDigest("yuri", {
    agentId: agent,
    minuteOfDay: 0,
    zone: "UTC",
    unreadOnly: false,
  });
  const prompt = digestPrompt(digest, Date.now())!;
  expect(prompt).toMatch(/Summarize the few things worth their attention/);
  expect(prompt).toContain("A faster build system");
  expect(prompt).toContain("https://example.com/builds");
  expect(prompt.length).toBeLessThan(12_000);
  // Nothing new means no thread.
  db.prepare("UPDATE feed_digests SET unread_only=1 WHERE id=?").run(digest.id);
  await call("/social/read-all", "POST", {}, "yuri");
  const quiet = db
    .prepare("SELECT * FROM feed_digests WHERE id=?")
    .get(digest.id) as any;
  expect(digestPrompt(quiet, Date.now())).toBe(null);
  expect(runDueDigests(Date.now())).toBe(0);
});

it("stops a digest whose agent is gone, and reports anything else", async () => {
  const agent = await workspace("zoe");
  db.prepare("UPDATE feed_digests SET enabled=0").run();
  const digest = saveDigest("zoe", {
    agentId: agent,
    minuteOfDay: 0,
    zone: "UTC",
    unreadOnly: false,
  });
  db.prepare("DELETE FROM agents WHERE id=?").run(agent);
  const before = (
    db
      .prepare(
        "SELECT last_event_id n FROM change_watermark WHERE owner_id='zoe'",
      )
      .get() as { n: number }
  ).n;
  runDueDigests(Date.now());
  const after = db
    .prepare("SELECT * FROM feed_digests WHERE id=?")
    .get(digest.id) as any;
  expect(after.enabled).toBe(0);
  expect(after.last_error).toBeTruthy();
  expect(
    db
      .prepare(
        "SELECT type,subject_kind,subject_id FROM events WHERE owner_id='zoe' AND id>?",
      )
      .all(before),
  ).toEqual([
    { type: "invalidate", subject_kind: "collection", subject_id: "social" },
  ]);
});

it("signals actual digest-worker success and empty results without duplicate status events", async () => {
  const owner = "digest-signals";
  const agent = await workspace(owner);
  db.prepare("UPDATE feed_digests SET enabled=0").run();
  const digest = saveDigest(owner, {
    agentId: agent,
    minuteOfDay: 0,
    zone: "UTC",
    unreadOnly: false,
  });
  const tip = () =>
    (
      db
        .prepare(
          "SELECT last_event_id n FROM change_watermark WHERE owner_id=?",
        )
        .get(owner) as { n: number }
    ).n;
  const signals = (after: number) =>
    (
      db
        .prepare(
          "SELECT type,payload FROM events WHERE owner_id=? AND id>? AND subject_kind='collection' AND subject_id='social'",
        )
        .all(owner, after) as { type: string; payload: string }[]
    )
      .map((row) =>
        parseEmission(null, row.type, JSON.parse(row.payload), {
          kind: "collection",
          id: "social",
        }),
      )
      .filter(
        (event) =>
          event.type === "invalidate" &&
          eventScopes(event).some((scope) => scope.id === "social"),
      );
  const at = Date.now();
  let before = tip();
  expect(runDueDigests(at)).toBe(1);
  expect(signals(before)).toHaveLength(1);
  before = tip();
  expect(runDueDigests(at)).toBe(0); // Already consumed: no duplicate status event.
  expect(tip()).toBe(before);
  expect(runDueDigests(at + 86400_000)).toBe(0); // Nothing new still updates last_run_at.
  expect(signals(before)).toHaveLength(1);
  expect(
    db
      .prepare("SELECT last_run_at,last_error FROM feed_digests WHERE id=?")
      .get(digest.id),
  ).toEqual({ last_run_at: at + 86400_000, last_error: null });
});

it("will not schedule a digest for someone else's agent or feed", async () => {
  const agent = await workspace("abe");
  expect(() =>
    saveDigest("bea", {
      agentId: agent,
      minuteOfDay: 0,
      zone: "UTC",
    }),
  ).toThrow();
  expect(() =>
    saveDigest("abe", {
      agentId: agent,
      minuteOfDay: 0,
      zone: "UTC",
      feeds: [feedById.get("lobsters")!.id],
    }),
  ).toThrow(/No such feed/);
  expect(() =>
    saveDigest("abe", { agentId: agent, minuteOfDay: 0, zone: "Mars/Olympus" }),
  ).toThrow(/time zone/);
});

it("manages digests over its own routes", async () => {
  const agent = await workspace("cleo");
  const made = await call(
    "/social/digests",
    "POST",
    { agentId: agent, minuteOfDay: 480, zone: "UTC" },
    "cleo",
  );
  expect(made.status).toBe(201);
  expect(
    (await call("/social/digests", "GET", undefined, "cleo")).data.digests,
  ).toHaveLength(1);
  const paused = await call(
    `/social/digests/${made.data.id}`,
    "PATCH",
    { agentId: agent, minuteOfDay: 540, zone: "UTC", enabled: false },
    "cleo",
  );
  expect(paused.data).toMatchObject({ minute_of_day: 540, enabled: 0 });
  // Someone else's digest is not theirs to read or remove.
  expect(
    (await call("/social/digests", "GET", undefined, "dale")).data.digests,
  ).toEqual([]);
  expect(
    (await call(`/social/digests/${made.data.id}`, "DELETE", undefined, "dale"))
      .status,
  ).toBe(404);
  expect(
    (await call(`/social/digests/${made.data.id}`, "DELETE", undefined, "cleo"))
      .data.digests,
  ).toEqual([]);
});

it("keeps a selected-feed digest enabled after a feed is unfollowed", async () => {
  const owner = "unfollow-digest";
  const agent = await workspace(owner);
  db.prepare("UPDATE feed_digests SET enabled=0").run();
  const digest = saveDigest(owner, {
    agentId: agent,
    feeds: ["hackernews"],
    minuteOfDay: 0,
    zone: "UTC",
    unreadOnly: false,
  });
  await call("/social/feeds/hackernews", "DELETE", undefined, owner);
  expect(digestPrompt(digest, Date.now())).toBeNull();
  const edit = {
    agentId: agent,
    feeds: ["hackernews"],
    minuteOfDay: 30,
    zone: "UTC",
    enabled: false,
  };
  const paused = await call(
    `/social/digests/${digest.id}`,
    "PATCH",
    edit,
    owner,
  );
  expect(paused.status).toBe(200);
  expect(saveDigest(owner, { ...edit, enabled: true }, digest.id).feeds).toBe(
    '["hackernews"]',
  );
  runDueDigests(Date.now());
  expect(
    db
      .prepare("SELECT enabled,last_error FROM feed_digests WHERE id=?")
      .get(digest.id),
  ).toEqual({ enabled: 1, last_error: null });
});
