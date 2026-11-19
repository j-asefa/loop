import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Queries for the review_follow_ups table (docs/architecture.md#recipe-add-or-extend-a-sql-table-module).

const insertStatement = statement(
  "INSERT INTO review_follow_ups(review_id,owner_id,previous_review_id) VALUES(?,?,?)",
);
export function insert(
  db: Database.Database,
  review: string,
  owner: string,
  previous: string,
) {
  insertStatement(db).run(review, owner, previous);
}

const byReviewStatement = statement(
  "SELECT * FROM review_follow_ups WHERE owner_id=? AND review_id=?",
);
/** The follow-up record of `review`; a full review has none. */
export function byReview(db: Database.Database, owner: string, review: string) {
  const row = byReviewStatement(db).get(owner, review);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.review_follow_ups, row, "review_follow_ups");
}
