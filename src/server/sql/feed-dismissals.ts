import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const removeOwnerFeedStatement = statement(
  "DELETE FROM feed_dismissals WHERE owner_id=? AND feed_id=?",
);
export function removeOwnerFeed(
  db: Database.Database,
  owner: string,
  feed: string,
) {
  return removeOwnerFeedStatement(db).run(owner, feed);
}

const removeFeedStatement = statement(
  "DELETE FROM feed_dismissals WHERE feed_id=?",
);
export function removeFeed(db: Database.Database, feed: string) {
  return removeFeedStatement(db).run(feed);
}

const marksStatement = statement(
  "SELECT feed_id,story_id FROM feed_dismissals WHERE owner_id=?",
);
const marksRow = QueryRecords.feed_dismissals.pick({
  feed_id: true,
  story_id: true,
});
export function marks(db: Database.Database, owner: string) {
  return marksStatement(db)
    .all(owner)
    .map((row) => parseRecord(marksRow, row, "feed_dismissals"));
}

const insertStatement = statement(
  "INSERT OR IGNORE INTO feed_dismissals(owner_id,feed_id,story_id,dismissed_at)\n           VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  feed: string,
  story: string,
  at: number,
) {
  return insertStatement(db).run(owner, feed, story, at);
}

const removeStatement = statement(
  "DELETE FROM feed_dismissals WHERE owner_id=? AND feed_id=? AND story_id=?",
);
export function remove(
  db: Database.Database,
  owner: string,
  feed: string,
  story: string,
) {
  return removeStatement(db).run(owner, feed, story);
}

const pruneMissingStatement =
  statement(`DELETE FROM feed_dismissals WHERE feed_id=@feed AND story_id NOT IN (
           SELECT story_id FROM feed_stories WHERE feed_id=@feed)`);
export function pruneMissing(db: Database.Database, feed: string) {
  return pruneMissingStatement(db).run({ feed });
}
