import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

export const reviewAccessSql =
  "SELECT id,owner_id,team_id,folder_id,fingerprint,run_id,created_at,source_path\n      FROM code_reviews INDEXED BY code_reviews_access WHERE owner_id=? AND id=?";
const accessStatement = statement(reviewAccessSql);
const accessRow = QueryRecords.code_reviews.pick({
  id: true,
  owner_id: true,
  team_id: true,
  folder_id: true,
  fingerprint: true,
  run_id: true,
  created_at: true,
  source_path: true,
});
export function access(db: Database.Database, owner: string, id: string) {
  const row = accessStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(accessRow, row, "code_reviews");
}

const snapshotStatement = statement(
  "SELECT snapshot FROM code_reviews WHERE owner_id=? AND id=? AND fingerprint=?",
);
const snapshotRow = QueryRecords.code_reviews.pick({ snapshot: true });
export function snapshot(
  db: Database.Database,
  owner: string,
  id: string,
  fingerprint: string,
) {
  const row = snapshotStatement(db).get(owner, id, fingerprint);
  return row === undefined
    ? undefined
    : parseRecord(snapshotRow, row, "code_reviews");
}

const requestStatement = statement(
  "SELECT id,request_hash FROM code_reviews WHERE owner_id=? AND request_key=?",
);
const requestRow = QueryRecords.code_reviews.pick({
  id: true,
  request_hash: true,
});
export function request(db: Database.Database, owner: string, key: string) {
  const row = requestStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(requestRow, row, "code_reviews");
}

const insertStatement = statement(
  "INSERT INTO code_reviews(id,owner_id,team_id,folder_id,request_key,request_hash,snapshot,fingerprint,created_at,source_path) VALUES(?,?,?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  team: string,
  folder: string,
  key: string,
  hash: string,
  snapshot: string,
  fingerprint: string,
  created: number,
  source: string,
) {
  return insertStatement(db).run(
    id,
    owner,
    team,
    folder,
    key,
    hash,
    snapshot,
    fingerprint,
    created,
    source,
  );
}

const setRunStatement = statement(
  "UPDATE code_reviews SET run_id=? WHERE id=?",
);
export function setRun(db: Database.Database, run: string, id: string) {
  return setRunStatement(db).run(run, id);
}

const runIdentityStatement = statement(
  "SELECT r.id,r.state FROM code_reviews c JOIN runs r ON r.id=c.run_id AND r.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=?",
);
const runIdentityRow = QueryRecords.runs.pick({ id: true, state: true });
export function runIdentity(db: Database.Database, id: string, owner: string) {
  const row = runIdentityStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(runIdentityRow, row, "code_reviews");
}

const runStatusStatement = statement(
  "SELECT c.run_id,r.state FROM code_reviews c JOIN runs r ON r.id=c.run_id AND r.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=?",
);
const runStatusRow = QueryRecords.code_reviews
  .pick({ run_id: true })
  .extend({ state: QueryRecords.runs.shape.state });
export function runStatus(db: Database.Database, id: string, owner: string) {
  const row = runStatusStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(runStatusRow, row, "code_reviews");
}

const agentReviewsStatement = statement(
  `SELECT c.id AS reviewId,r.state,c.fingerprint,c.created_at AS createdAt,
      f.previous_review_id AS previousReviewId,
      CASE WHEN f.review_id IS NULL THEN 'full' ELSE 'follow_up' END AS depth
    FROM code_reviews c
    LEFT JOIN review_follow_ups f ON f.review_id=c.id AND f.owner_id=c.owner_id
    JOIN runs r ON r.id=c.run_id AND r.owner_id=c.owner_id
    JOIN delegations d ON d.child_run_id=c.run_id
    JOIN runs p ON p.id=d.parent_run_id AND p.owner_id=c.owner_id
    WHERE c.owner_id=@owner AND p.agent_id=@agent AND (@review IS NULL OR c.id=@review)
    ORDER BY c.created_at DESC,c.id LIMIT 10`,
);
const agentReviewsRow = z.object({
  depth: z.enum(["full", "follow_up"]),
  previousReviewId: z.string().nullable(),
  reviewId: z.string(),
  state: QueryRecords.runs.shape.state,
  fingerprint: z.string(),
  createdAt: z.number(),
});
export function agentReviews(
  db: Database.Database,
  owner: string,
  agent: string | null,
  review: string | null,
) {
  return agentReviewsStatement(db)
    .all({ owner, agent, review })
    .map((row) => parseRecord(agentReviewsRow, row, "code_reviews"));
}

// Earlier reviews this conversation requested of the same checkout, newest
// first. The identity columns come from the covering index so the candidate
// list never reads a snapshot. `unfinished` counts reviewers that did not
// complete; a follow-up review has no reviewers.
const earlierStatement = statement(
  `SELECT a.id,r.state,r.result,f.previous_review_id IS NOT NULL follow_up,
      (SELECT count(*) FROM delegations rd JOIN runs rr ON rr.id=rd.child_run_id
        WHERE rd.parent_run_id=c.run_id AND rr.state<>'completed') unfinished
    FROM runs p
    JOIN delegations d ON d.parent_run_id=p.id
    JOIN code_reviews c INDEXED BY code_reviews_run ON c.run_id=d.child_run_id
    JOIN code_reviews a INDEXED BY code_reviews_access ON a.owner_id=p.owner_id AND a.id=c.id
    JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    LEFT JOIN review_follow_ups f ON f.review_id=a.id AND f.owner_id=a.owner_id
    WHERE p.owner_id=@owner AND p.conversation_id=@conversation
      AND a.team_id=@team AND a.folder_id=@folder AND a.source_path=@path
    ORDER BY a.rowid DESC LIMIT 8`,
);
const earlierRow = z.object({
  id: z.string(),
  state: QueryRecords.runs.shape.state,
  result: z.string().nullable(),
  follow_up: z.number(),
  unfinished: z.number(),
});
export function earlier(
  db: Database.Database,
  scope: {
    owner: string;
    conversation: string;
    team: string;
    folder: string;
    path: string;
  },
) {
  return earlierStatement(db)
    .all(scope)
    .map((row) => parseRecord(earlierRow, row, "code_reviews"));
}
