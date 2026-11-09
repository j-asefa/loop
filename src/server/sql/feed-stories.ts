import { followedSql } from "./feed-subscriptions.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const recentStatement = statement(
  "SELECT story,first_seen_at FROM feed_stories WHERE feed_id=?\n       ORDER BY COALESCE(published_at, first_seen_at) DESC, story_id LIMIT ?",
);
const recentRow = QueryRecords.feed_stories.pick({
  story: true,
  first_seen_at: true,
});
export function recent(db: Database.Database, feed: string, limit: number) {
  return recentStatement(db)
    .all(feed, limit)
    .map((row) => parseRecord(recentRow, row, "feed_stories"));
}

const pruneStatement = statement(
  "DELETE FROM feed_stories WHERE feed_id=@feed AND story_id NOT IN (\n         SELECT story_id FROM feed_stories WHERE feed_id=@feed\n         ORDER BY COALESCE(published_at, first_seen_at) DESC, story_id LIMIT @keep)\n       -- A story someone saved for later is kept however old it becomes.\n       AND NOT EXISTS(SELECT 1 FROM later_items l\n         WHERE l.kind='story' AND l.done_at IS NULL\n         AND l.target_id=@feed || ':' || feed_stories.story_id)",
);
export function prune(
  db: Database.Database,
  args: { feed: string; keep: number },
) {
  return pruneStatement(db).run(args);
}

const countStatement = statement(
  "SELECT count(*) n FROM feed_stories WHERE feed_id=?",
);
const countRow = z.object({ n: z.number() });
export function count(db: Database.Database, feed: string) {
  const row = countStatement(db).get(feed);
  return row === undefined
    ? undefined
    : parseRecord(countRow, row, "feed_stories");
}

const removeFeedStatement = statement(
  "DELETE FROM feed_stories WHERE feed_id=?",
);
export function removeFeed(db: Database.Database, feed: string) {
  return removeFeedStatement(db).run(feed);
}

const clearStatement = statement("DELETE FROM feed_stories");
export function clear(db: Database.Database) {
  return clearStatement(db).run();
}
const upsertStatement =
  statement(`INSERT INTO feed_stories(feed_id,story_id,url,title,summary,story,published_at,first_seen_at,fetched_at)
       VALUES(@feed,@id,@url,@title,@summary,@story,@published,@fetched,@fetched)
       ON CONFLICT(feed_id,story_id) DO UPDATE SET
         url=excluded.url, title=excluded.title, summary=excluded.summary,
         story=excluded.story, published_at=excluded.published_at,
         fetched_at=excluded.fetched_at`);
export function upsert(
  db: Database.Database,
  feed: string,
  id: string,
  url: string,
  title: string,
  summary: string | null,
  story: string,
  published: number | null,
  fetched: number,
) {
  return upsertStatement(db).run({
    feed,
    id,
    url,
    title,
    summary,
    story,
    published,
    fetched,
  });
}

const ownedStatement =
  statement(`SELECT s.story,s.first_seen_at FROM feed_stories s
       JOIN (${followedSql}) b ON b.feed_id=s.feed_id AND b.owner_id=?
       WHERE s.feed_id=? AND s.story_id=?`);
const ownedRow = QueryRecords.feed_stories.pick({
  story: true,
  first_seen_at: true,
});
export function owned(
  db: Database.Database,
  owner: string,
  feed: string,
  story: string,
) {
  const row = ownedStatement(db).get(owner, feed, story);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "feed_stories");
}
