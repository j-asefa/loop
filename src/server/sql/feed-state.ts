import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const byFeedStatement = statement("SELECT * FROM feed_state WHERE feed_id=?");
const byFeedRow = QueryRecords.feed_state.omit({ title: true, home: true });
export function byFeed(db: Database.Database, feed: string) {
  const row = byFeedStatement(db).get(feed);
  return row === undefined
    ? undefined
    : parseRecord(byFeedRow, row, "feed_state");
}

const receivedStatement = statement(
  "INSERT INTO feed_state(feed_id,title,home,fetched_at,failed_at,failures,error,retry_at,etag,last_modified,stories)\n       VALUES(@feed,@title,@home,@at,NULL,0,NULL,NULL,@etag,@modified,@stories)\n       ON CONFLICT(feed_id) DO UPDATE SET\n         title=excluded.title, home=excluded.home, fetched_at=excluded.fetched_at,\n         failed_at=NULL, failures=0, error=NULL, retry_at=NULL,\n         etag=excluded.etag, last_modified=excluded.last_modified,\n         stories=excluded.stories",
);
export function received(
  db: Database.Database,
  args: {
    feed: string;
    title: string | null;
    home: string | null;
    at: number;
    etag: string | null;
    modified: string | null;
    stories: number;
  },
) {
  return receivedStatement(db).run(args);
}

const touchStatement = statement(
  "UPDATE feed_state SET fetched_at=?,failed_at=NULL,failures=0,error=NULL,retry_at=NULL WHERE feed_id=?",
);
export function touch(db: Database.Database, at: number, feed: string) {
  return touchStatement(db).run(at, feed);
}

const failedStatement = statement(
  "INSERT INTO feed_state(feed_id,failed_at,failures,error,retry_at)\n     VALUES(@feed,@at,@failures,@error,@retry)\n     ON CONFLICT(feed_id) DO UPDATE SET\n       failed_at=excluded.failed_at, failures=excluded.failures,\n       error=excluded.error, retry_at=excluded.retry_at",
);
export function failed(
  db: Database.Database,
  args: {
    feed: string;
    at: number;
    failures: number;
    error: string;
    retry: number;
  },
) {
  return failedStatement(db).run(args);
}

const abandonedStatement = statement(
  "SELECT feed_id FROM feed_state\n       WHERE COALESCE(fetched_at, failed_at, 0) < ?\n       AND feed_id NOT IN (SELECT feed_id FROM feed_subscriptions)\n       AND feed_id NOT IN (SELECT id FROM feed_sources)",
);
const abandonedRow = QueryRecords.feed_state.pick({ feed_id: true });
export function abandoned(db: Database.Database, before: number) {
  return abandonedStatement(db)
    .all(before)
    .map((row) => parseRecord(abandonedRow, row, "feed_state"));
}

const removeFeedStatement = statement("DELETE FROM feed_state WHERE feed_id=?");
export function removeFeed(db: Database.Database, feed: string) {
  return removeFeedStatement(db).run(feed);
}

const clearStatement = statement("DELETE FROM feed_state");
export function clear(db: Database.Database) {
  return clearStatement(db).run();
}
