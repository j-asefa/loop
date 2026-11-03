import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// The worker's own feed pass, driven through startWorker's interval rather
// than by calling the jobs directly: refreshing feeds, then looking for watch
// matches in what those reads brought in.

vi.mock("../src/server/search", () => ({ indexPending: async () => {} }));
vi.mock("../src/server/memory", async (original) => ({
  ...(await original<any>()),
  indexMemory: async () => {},
}));

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const rss = (titles: string[]) =>
  `<rss version="2.0"><channel><title>Lobsters</title><link>https://lobste.rs/</link>${titles
    .map(
      (title, i) =>
        `<item><title>${title}</title><link>https://example.com/w${i}</link><pubDate>Mon, 0${
          (i % 5) + 1
        } Oct 2026 09:00:00 +0000</pubDate></item>`,
    )
    .join("")}</channel></rss>`;

/** A worker on its own data directory, with the feed network replaced. */
async function worker(feed: () => Promise<Response>) {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), "loop-feed-worker-"));
  dirs.push(dir);
  vi.stubEnv("LOOP_PROFILE", "server");
  vi.stubEnv("LOOP_DATA_DIR", dir);
  vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  const { db } = await import("../src/server/db");
  const news = await import("../src/server/news");
  const watches = await import("../src/server/feed-watches");
  const digests = await import("../src/server/feed-digests");
  const { startWorker } = await import("../src/server/worker");
  const restore = news.withNewsFixture(feed);
  db.prepare(
    "INSERT INTO feed_subscriptions(owner_id,feed_id,created_at) VALUES('owner','lobsters',1)",
  ).run();
  db.prepare(
    "INSERT INTO push_subscriptions(id,owner_id,endpoint,subscription,created_at) VALUES('d','owner','https://fcm.googleapis.com/d','{}',0)",
  ).run();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const stop = startWorker();
  return {
    db,
    news,
    watches,
    digests,
    /** One pass of the worker's sixty-second feed interval. */
    pass: () => vi.advanceTimersByTimeAsync(60_000),
    async close() {
      await stop();
      restore();
    },
  };
}

it("matches watches from the worker's own pass", async () => {
  const w = await worker(async () => new Response(rss(["Rust in the kernel"])));
  try {
    const watch = w.watches.saveWatch("owner", { query: "rust" });
    // Nothing has been read yet, so there is nothing to match.
    expect(w.watches.listWatches("owner")[0].matches).toBe(0);
    // The real interval: read the feed, then look for matches in what it read.
    await w.pass();
    expect(w.watches.listWatches("owner")[0].matches).toBe(1);
    expect(
      w.db
        .prepare("SELECT count(*) n FROM feed_watch_hits WHERE watch_id=?")
        .get(watch.id),
    ).toEqual({ n: 1 });
    expect(
      w.db.prepare("SELECT title,body FROM push_messages").get(),
    ).toMatchObject({ body: "Rust in the kernel" });
  } finally {
    await w.close();
  }
}, 30_000);
