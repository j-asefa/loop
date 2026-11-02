import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statementVariants } from "./statement.js";
const searchStatement = statementVariants();
const searchRow = QueryRecords.feed_stories
  .pick({ feed_id: true, story_id: true, story: true, first_seen_at: true })
  .extend({ rank: z.number() });
export function search(
  db: Database.Database,
  match: string,
  feeds: string[],
  limit: number,
) {
  return searchStatement(
    `SELECT s.feed_id,s.story_id,s.story,s.first_seen_at,
         bm25(feed_search, 4.0, 1.0) rank
       FROM feed_search JOIN feed_stories s ON s.rowid=feed_search.rowid
       WHERE feed_search MATCH @match AND s.feed_id IN (${feeds
         .map(() => "?")
         .join(",")})
       ORDER BY rank, COALESCE(s.published_at, s.first_seen_at) DESC
       LIMIT @limit`,
    db,
  )
    .all({ match, limit }, ...feeds)
    .map((row) => parseRecord(searchRow, row, "feed_search"));
}
