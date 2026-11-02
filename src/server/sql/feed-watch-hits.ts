import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const insertStatement = statement(
  "INSERT INTO feed_watch_hits(watch_id,feed_id,story_id,matched_at,pushed)\n           VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  watch: string,
  feed: string,
  story: string,
  matched: number,
  pushed: number,
) {
  return insertStatement(db).run(watch, feed, story, matched, pushed);
}

const announcedStatement = statement(
  "SELECT feed_id,story_id FROM feed_watch_hits WHERE watch_id=?",
);
const announcedRow = QueryRecords.feed_watch_hits.pick({
  feed_id: true,
  story_id: true,
});
export function announced(db: Database.Database, watch: string) {
  return announcedStatement(db)
    .all(watch)
    .map((row) => parseRecord(announcedRow, row, "feed_watch_hits"));
}

const pushedSinceStatements = statementVariants();
export function pushedSince(
  db: Database.Database,
  since: number,
  identity: string,
  watch: boolean,
) {
  return parseRecord(
    z.object({ n: z.number() }),
    pushedSinceStatements(
      "SELECT count(*) n FROM feed_watch_hits h JOIN feed_watches w ON w.id=h.watch_id WHERE h.pushed=1 AND h.matched_at>? AND " +
        (watch ? "h.watch_id=?" : "w.owner_id=?"),
      db,
    ).get(since, identity),
    "feed_watch_hits",
  );
}

const removeFeedStatement = statement(
  "DELETE FROM feed_watch_hits WHERE feed_id=?",
);
export function removeFeed(db: Database.Database, feed: string) {
  return removeFeedStatement(db).run(feed);
}

const pruneMissingStatement =
  statement(`DELETE FROM feed_watch_hits WHERE feed_id=@feed AND story_id NOT IN (
           SELECT story_id FROM feed_stories WHERE feed_id=@feed)`);
export function pruneMissing(db: Database.Database, feed: string) {
  return pruneMissingStatement(db).run({ feed });
}
