import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const accessStatement = statement(
  "SELECT id,owner_id,team_id,folder_id,fingerprint,run_id,created_at,source_path\n      FROM code_reviews INDEXED BY code_reviews_access WHERE owner_id=? AND id=?",
);
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
  "SELECT c.id AS reviewId,r.state,c.fingerprint,c.created_at AS createdAt FROM code_reviews c\n    JOIN runs r ON r.id=c.run_id AND r.owner_id=c.owner_id\n    JOIN delegations d ON d.child_run_id=c.run_id\n    JOIN runs p ON p.id=d.parent_run_id AND p.owner_id=c.owner_id\n    WHERE c.owner_id=@owner AND p.agent_id=@agent AND (@review IS NULL OR c.id=@review)\n    ORDER BY c.created_at DESC,c.id LIMIT 10",
);
const agentReviewsRow = z.object({
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
