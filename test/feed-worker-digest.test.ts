import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// A digest must not be consumed before the pass that feeds it has settled.
// One case per file: a mock factory's module graph outlives
// vi.resetModules(), so a second case here would drive its worker against the
// first case's database.

const { executeAgent } = vi.hoisted(() => ({ executeAgent: vi.fn() }));
vi.mock("../src/server/agent-runtime", async (original) => ({
  ...(await original<any>()),
  executeAgent,
}));
vi.mock("../src/server/search", () => ({ indexPending: async () => {} }));
vi.mock("../src/server/memory", async (original) => ({
  ...(await original<any>()),
  captureMemory: () => {},
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
  vi.stubEnv("LOOP_DATA_DIR", dir);
  vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  const { db } = await import("../src/server/db");
  const { seal } = await import("../src/server/secrets");
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
    seal,
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

it("dispatches a digest only once its feeds have been read", async () => {
  // A feed that answers slowly: the digest must not run against an empty
  // store and then record itself as done for the day.
  let answer: (value: Response) => void = () => {};
  const held = new Promise<Response>((resolve) => (answer = resolve));
  const w = await worker(() => held);
  try {
    const agent = "agent-1";
    const connection = "connection-1";
    w.db
      .prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'owner','openai','Fixture',?,'connected','[{\"id\":\"fixture\"}]',0)",
      )
      .run(connection, w.seal("fixture-api-key", "owner"));
    w.db
      .prepare(
        "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,'owner','Scout','scout','openai',?,'fixture',0)",
      )
      .run(agent, connection);
    const digest = w.digests.saveDigest("owner", {
      agentId: agent,
      minuteOfDay: 0,
      zone: "UTC",
      unreadOnly: false,
    });
    const pass = w.pass();
    // The read has not answered, so the digest has not been consumed.
    await new Promise((done) => setTimeout(done, 50));
    expect(
      w.db
        .prepare("SELECT last_run_at FROM feed_digests WHERE id=?")
        .get(digest.id),
    ).toEqual({ last_run_at: null });
    answer(new Response(rss(["A faster build system"])));
    await pass;
    // Now it has run, against the stories that pass brought in.

    // Advancing the maintenance interval starts its async read, but does not
    // await that read and its digest continuation. Observe the durable result.
    await expect
      .poll(() => {
        const run = w.db
          .prepare("SELECT input FROM runs WHERE owner_id='owner'")
          .get() as { input: string } | undefined;
        return run?.input;
      })
      .toContain("A faster build system");

    // A second local day with nothing new sends nothing: a digest covers what
    // arrived since the last one, and it marks nothing read, so without the
    // arrival boundary it would summarize the same headline every day.
    const quiet = w.db
      .prepare("SELECT * FROM feed_digests WHERE id=?")
      .get(digest.id) as any;
    expect(w.digests.digestPrompt(quiet, Date.now())).toBe(null);
    expect(w.digests.runDueDigests(Date.now())).toBe(0);
    expect(
      w.db.prepare("SELECT count(*) n FROM runs WHERE owner_id='owner'").get(),
    ).toEqual({ n: 1 });
  } finally {
    await w.close();
  }
}, 30_000);
