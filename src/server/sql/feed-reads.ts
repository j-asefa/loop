import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const removeOwnerFeedStatement = statement(
  "DELETE FROM feed_reads WHERE owner_id=? AND feed_id=?",
);
export function removeOwnerFeed(
  db: Database.Database,
  owner: string,
  feed: string,
) {
  return removeOwnerFeedStatement(db).run(owner, feed);
}

const removeFeedStatement = statement("DELETE FROM feed_reads WHERE feed_id=?");
export function removeFeed(db: Database.Database, feed: string) {
  return removeFeedStatement(db).run(feed);
}

const marksStatement = statement(
  "SELECT feed_id,story_id,is_read FROM feed_reads WHERE owner_id=?",
);
const marksRow = QueryRecords.feed_reads.pick({
  feed_id: true,
  story_id: true,
  is_read: true,
});
export function marks(db: Database.Database, owner: string) {
  return marksStatement(db)
    .all(owner)
    .map((row) => parseRecord(marksRow, row, "feed_reads"));
}

const markStatement = statement(
  "INSERT INTO feed_reads(owner_id,feed_id,story_id,read_at,is_read)\n         VALUES(?,?,?,?,?)\n         ON CONFLICT(owner_id,feed_id,story_id) DO UPDATE SET\n           read_at=excluded.read_at, is_read=excluded.is_read",
);
export function mark(
  db: Database.Database,
  owner: string,
  feed: string,
  story: string,
  at: number,
  read: number,
) {
  return markStatement(db).run(owner, feed, story, at, read);
}

const pruneMissingStatement =
  statement(`DELETE FROM feed_reads WHERE feed_id=@feed AND story_id NOT IN (
           SELECT story_id FROM feed_stories WHERE feed_id=@feed)`);
export function pruneMissing(db: Database.Database, feed: string) {
  return pruneMissingStatement(db).run({ feed });
}

const clearMarksStatement = statementVariants();
export function clearMarks(
  db: Database.Database,
  owner: string,
  feed?: string,
) {
  return clearMarksStatement(
    `DELETE FROM feed_reads WHERE owner_id=?${feed ? " AND feed_id=?" : ""}`,
    db,
  ).run(...[owner, ...(feed ? [feed] : [])]);
}
