import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { Problem } from "./domain.js";
import { enqueuePush } from "./mobile-return.js";
import { ownerFeed, ownerFeeds, storiesForWatch } from "./news.js";
import { matchesWatch, watchTerms } from "../shared/news.js";

// A word or phrase followed across the feeds you added. Matching runs over
// stories Loop has already read, so a watch never causes a fetch, and each
// story is announced once: the hit and its push are written together, so a
// crash between them can neither lose nor repeat one.

const PER_OWNER = 25;
const MAX_QUERY = 200;
/** Stories considered per watch per pass, newest first. */
const PER_PASS = 50;
// A busy watch must not empty your battery: three an hour, then one line
// saying how many more matched.
const PUSH_PER_WATCH_HOUR = 3;
const PUSH_PER_OWNER_HOUR = 10;
const HOUR = 60 * 60_000;

export type FeedWatch = {
  id: string;
  owner_id: string;
  query: string;
  feeds: string | null;
  created_at: number;
  since_at: number;
  enabled: number;
  matches: number;
  last_match_at: number | null;
};

const watchInput = z.object({
  query: z.string().min(2).max(MAX_QUERY),
  feeds: z.array(z.string().min(1).max(120)).max(200).nullish(),
  enabled: z.boolean().default(true),
});

export const listWatches = (owner: string) =>
  db
    .prepare("SELECT * FROM feed_watches WHERE owner_id=? ORDER BY created_at")
    .all(owner) as FeedWatch[];

function checked(owner: string, body: unknown) {
  const d = watchInput.parse(body);
  if (!watchTerms(d.query).length)
    throw new Problem(400, "Enter a word or phrase to follow.");
  for (const feed of d.feeds || []) ownerFeed(owner, feed);
  return d;
}

export function saveWatch(owner: string, body: unknown, watchId?: string) {
  const d = checked(owner, body);
  const time = now();
  if (watchId) {
    const changed = db
      .prepare(
        `UPDATE feed_watches SET query=?,feeds=CASE WHEN ? THEN ? ELSE feeds END,enabled=? WHERE id=? AND owner_id=?`,
      )
      .run(
        d.query,
        d.feeds !== undefined ? 1 : 0,
        d.feeds?.length ? JSON.stringify(d.feeds) : null,
        d.enabled ? 1 : 0,
        watchId,
        owner,
      ).changes;
    if (!changed) throw new Problem(404, "No such watch.");
  } else {
    if (listWatches(owner).length >= PER_OWNER)
      throw new Problem(400, `You can follow ${PER_OWNER} words or phrases.`);
    watchId = id();
    db.prepare(
      `INSERT INTO feed_watches(id,owner_id,query,feeds,created_at,since_at,enabled)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(
      watchId,
      owner,
      d.query,
      d.feeds?.length ? JSON.stringify(d.feeds) : null,
      time,
      // A new watch is not a backlog of notifications: it starts from now.
      time,
      d.enabled ? 1 : 0,
    );
  }
  return db
    .prepare("SELECT * FROM feed_watches WHERE id=? AND owner_id=?")
    .get(watchId, owner) as FeedWatch;
}

export function removeWatch(owner: string, watchId: string) {
  const changed = db
    .prepare("DELETE FROM feed_watches WHERE id=? AND owner_id=?")
    .run(watchId, owner).changes;
  if (!changed) throw new Problem(404, "No such watch.");
}

/**
 * What a watch would have caught, over the stories already stored. Creates
 * nothing and pushes nothing: it is how someone can tell whether a watch is
 * worth having before they make one.
 */
export function previewWatch(owner: string, body: unknown) {
  const d = checked(owner, body);
  const terms = watchTerms(d.query);
  return {
    stories: candidates(owner, d.feeds ?? null, 0, ({ story }) => matchesWatch(terms, story))
      .slice(0, 10)
      .map(({ feed, story }) => ({
        feed,
        title: story.title,
        url: story.url,
        published_at: story.published_at,
      })),
  };
}

/**
 * Stories of the feeds a watch covers, newest first, first seen since `at`,
 * narrowed by `keep` before the per-pass limit so nothing behind the limit is
 * skipped for good.
 */
function candidates(
  owner: string,
  feeds: string[] | null,
  since: number,
  keep?: Parameters<typeof storiesForWatch>[4],
) {
  const covered = new Set(
    feeds?.length ? feeds : ownerFeeds(owner).map((feed) => feed.id),
  );
  return storiesForWatch(owner, [...covered], since, PER_PASS, keep);
}

const pushedSince = (watchId: string, owner: string, at: number) =>
  (
    db
      .prepare(
        `SELECT count(*) n FROM feed_watch_hits h JOIN feed_watches w ON w.id=h.watch_id
         WHERE h.pushed=1 AND h.matched_at>? AND ${
           watchId ? "h.watch_id=?" : "w.owner_id=?"
         }`,
      )
      .get(at - HOUR, watchId || owner) as { n: number }
  ).n;

/**
 * Worker job: announces stories matching each watch, once each. Runs after
 * the feed refresh, so a story found and a story announced happen in the
 * same pass.
 */
export function matchWatches(at = now()) {
  let pushed = 0;
  const watches = db
    .prepare("SELECT * FROM feed_watches WHERE enabled=1")
    .all() as FeedWatch[];
  for (const watch of watches) {
    const terms = watchTerms(watch.query);
    const feeds: string[] | null = watch.feeds ? JSON.parse(watch.feeds) : null;
    // Already-announced stories are excluded before the per-pass limit, so a
    // feed that brings in more than PER_PASS matches at once is worked
    // through over the following passes rather than stuck on its newest.
    const seen = announced(watch.id);
    const fresh = candidates(
      watch.owner_id,
      feeds,
      watch.since_at,
      ({ feed_id, story }) =>
        matchesWatch(terms, story) && !seen.has(`${feed_id}:${story.id}`),
    );
    if (!fresh.length) continue;
    let held = 0;
    for (const { feed, feed_id, story } of fresh) {
      const loud =
        pushedSince(watch.id, watch.owner_id, at) >= PUSH_PER_WATCH_HOUR ||
        pushedSince("", watch.owner_id, at) >= PUSH_PER_OWNER_HOUR;
      // The hit and its push commit together: a crash between them would
      // either announce a story twice or never.
      db.transaction(() => {
        db.prepare(
          `INSERT INTO feed_watch_hits(watch_id,feed_id,story_id,matched_at,pushed)
           VALUES(?,?,?,?,?)`,
        ).run(watch.id, feed_id, story.id, at, loud ? 0 : 1);
        db.prepare(
          "UPDATE feed_watches SET matches=matches+1,last_match_at=? WHERE id=?",
        ).run(at, watch.id);
        if (loud) return;
        // A public headline is what is already on the page it links to, so it
        // is safe on a lock screen; nothing else from Loop goes in it.
        enqueuePush(watch.owner_id, `feed-watch:${watch.id}:${story.id}`, {
          title: `“${watch.query}” · ${feed}`,
          body: story.title,
          url: `/?social=${encodeURIComponent(`${feed_id}:${story.id}`)}`,
        });
      })();
      if (loud) held++;
      else pushed++;
    }
    if (held)
      enqueuePush(
        watch.owner_id,
        `feed-watch-more:${watch.id}:${Math.floor(at / HOUR)}`,
        {
          title: `“${watch.query}”`,
          body: `${held} more ${held === 1 ? "story" : "stories"} matched.`,
          url: "/?social=1",
        },
      );
  }
  return pushed;
}

/** Every story this watch has already announced, as "<feed>:<story>". */
const announced = (watchId: string) =>
  new Set(
    (
      db
        .prepare(
          "SELECT feed_id,story_id FROM feed_watch_hits WHERE watch_id=?",
        )
        .all(watchId) as { feed_id: string; story_id: string }[]
    ).map((row) => `${row.feed_id}:${row.story_id}`),
  );

export const feedWatches = Router();
feedWatches.get("/social/watches", (_req, res) => {
  res.json({ watches: listWatches(res.locals.owner) });
});
feedWatches.post("/social/watches", (req, res) => {
  res.status(201).json(saveWatch(res.locals.owner, req.body));
});
feedWatches.post("/social/watches/preview", (req, res) => {
  res.json(previewWatch(res.locals.owner, req.body));
});
feedWatches.patch("/social/watches/:id", (req, res) => {
  res.json(saveWatch(res.locals.owner, req.body, req.params.id));
});
feedWatches.delete("/social/watches/:id", (req, res) => {
  removeWatch(res.locals.owner, req.params.id);
  res.json({ watches: listWatches(res.locals.owner) });
});
