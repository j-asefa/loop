import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT INTO review_continuations(review_id,owner_id,parent_run_id,run_id) VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  review: string,
  owner: string,
  parent: string,
  run: string,
) {
  insertStatement(db).run(review, owner, parent, run);
}

const byRunStatement = statement(
  "SELECT * FROM review_continuations WHERE run_id=?",
);
export function byRun(db: Database.Database, run: string) {
  const row = byRunStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(
        QueryRecords.review_continuations,
        row,
        "review_continuations",
      );
}

const stoppedStatement =
  statement(`SELECT r.id,r.owner_id FROM review_continuations rc
 JOIN runs r ON r.id=rc.run_id AND r.owner_id=rc.owner_id
 JOIN runs p ON p.id=rc.parent_run_id AND p.owner_id=rc.owner_id
 WHERE r.state IN ('queued','paused') AND p.state IN ('cancelled','failed','interrupted')`);
export function stopped(db: Database.Database) {
  return stoppedStatement(db)
    .all()
    .map((row) =>
      parseRecord(
        QueryRecords.runs.pick({ id: true, owner_id: true }),
        row,
        "runs",
      ),
    );
}

// Eligibility is rechecked by claim in the same transaction as the lease.
// A failed/interrupted requester requires explicit recovery, never a new prompt
// automatically dispatched after an uncertain outcome.
export const READY_REVIEW_CONTINUATION = (run: string) => `NOT EXISTS (
  SELECT 1 FROM review_continuations rc WHERE rc.run_id=${run}.id AND NOT EXISTS (
    SELECT 1 FROM code_reviews cr
    JOIN runs lead ON lead.id=cr.run_id AND lead.owner_id=rc.owner_id
    JOIN runs parent ON parent.id=rc.parent_run_id AND parent.owner_id=rc.owner_id
    JOIN agents agent ON agent.id=parent.agent_id AND agent.owner_id=rc.owner_id
    JOIN connections connection ON connection.id=json_extract(${run}.payload,'$.connectionId') AND connection.owner_id=rc.owner_id
    WHERE cr.id=rc.review_id AND cr.owner_id=rc.owner_id AND rc.owner_id=${run}.owner_id
      AND parent.agent_id=${run}.agent_id AND parent.conversation_id=${run}.conversation_id
      AND agent.retired_at IS NULL AND parent.state='completed'
      AND connection.status='connected'
      AND lead.state IN ('completed','failed','cancelled','interrupted')
  )
)`;

const shouldDeferStatement = statement(`SELECT r.id FROM runs r
 JOIN review_continuations rc ON rc.run_id=r.id AND rc.owner_id=r.owner_id
 WHERE r.id=? AND r.owner_id=? AND NOT (${READY_REVIEW_CONTINUATION("r")})
   AND NOT EXISTS(SELECT 1 FROM native_dispatch d WHERE d.run_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.run_id=r.id)`);
export function shouldDefer(db: Database.Database, run: string, owner: string) {
  return shouldDeferStatement(db).get(run, owner) !== undefined;
}
