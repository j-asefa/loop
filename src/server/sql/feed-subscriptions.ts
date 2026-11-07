import { feedById } from "../../shared/news.js";
import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const feedsStatement = statement(
  "SELECT feed_id FROM feed_subscriptions WHERE owner_id=? ORDER BY created_at, feed_id",
);
const feedsRow = QueryRecords.feed_subscriptions.pick({ feed_id: true });
export function feeds(db: Database.Database, owner: string) {
  return feedsStatement(db)
    .all(owner)
    .map((row) => parseRecord(feedsRow, row, "feed_subscriptions"));
}

const insertStatement = statement(
  "INSERT OR IGNORE INTO feed_subscriptions(owner_id, feed_id, created_at) VALUES(?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  feed: string,
  at: number,
) {
  return insertStatement(db).run(owner, feed, at);
}

const removeStatement = statement(
  "DELETE FROM feed_subscriptions WHERE owner_id=? AND feed_id=?",
);
export function remove(db: Database.Database, owner: string, feed: string) {
  return removeStatement(db).run(owner, feed);
}

export const followedSql = `SELECT owner_id,feed_id,read_through_at FROM feed_subscriptions
 WHERE feed_id IN (${[...feedById.keys()].map((id) => "'" + id.replaceAll("'", "''") + "'").join(",")})
 UNION ALL SELECT owner_id,id,read_through_at FROM feed_sources`;

const dueStatement =
  statement(`SELECT s.owner_id,s.feed_id FROM (${followedSql}) s
         LEFT JOIN feed_state f ON f.feed_id=s.feed_id
         WHERE COALESCE(f.fetched_at,0)<=@stale AND COALESCE(f.retry_at,0)<=@at
         GROUP BY s.feed_id
         ORDER BY COALESCE(MIN(f.fetched_at),0), s.feed_id LIMIT @limit`);
const dueRow = QueryRecords.feed_subscriptions.pick({
  owner_id: true,
  feed_id: true,
});
export function due(
  db: Database.Database,
  args: { stale: number; at: number; limit: number },
) {
  return dueStatement(db)
    .all(args)
    .map((row) => parseRecord(dueRow, row, "feed_subscriptions"));
}

const readThroughStatement = statement(
  `SELECT feed_id,read_through_at FROM (${followedSql}) WHERE owner_id=?`,
);
const readThroughRow = QueryRecords.feed_subscriptions.pick({
  feed_id: true,
  read_through_at: true,
});
export function readThrough(db: Database.Database, owner: string) {
  return readThroughStatement(db)
    .all(owner)
    .map((row) => parseRecord(readThroughRow, row, "feed_subscriptions"));
}

const markThroughStatement = statementVariants();
export function markThrough(
  db: Database.Database,
  at: number,
  owner: string,
  feed?: string,
) {
  return markThroughStatement(
    `UPDATE feed_subscriptions SET read_through_at=?
     WHERE owner_id=?${feed ? " AND feed_id=?" : ""}`,
    db,
  ).run(...[at, owner, ...(feed ? [feed] : [])]);
}
