import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const clearPendingStatement = statement(
  "UPDATE run_checkouts SET capture_pending=0 WHERE run_id=?",
);
export function clearPending(db: Database.Database, run: string) {
  return clearPendingStatement(db).run(run);
}

const acquireCaptureStatement = statement(
  "UPDATE run_checkouts SET capture_token=?,capture_started_at=?,capture_pending=0 WHERE run_id=? AND (capture_token IS NULL OR capture_started_at<?) RETURNING *",
);

export function acquireCapture(
  db: Database.Database,
  token: string,
  time: number,
  run: string,
  expired: number,
) {
  const row = acquireCaptureStatement(db).get(token, time, run, expired);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.run_checkouts, row, "run_checkouts");
}

const markPendingStatement = statement(
  "UPDATE run_checkouts SET capture_pending=1 WHERE run_id=?",
);
export function markPending(db: Database.Database, run: string) {
  return markPendingStatement(db).run(run);
}

const releaseCaptureStatement = statement(
  "UPDATE run_checkouts SET capture_token=NULL,capture_started_at=NULL WHERE run_id=? AND capture_token=? RETURNING capture_pending",
);
const releaseCaptureRow = QueryRecords.run_checkouts.pick({
  capture_pending: true,
});
export function releaseCapture(
  db: Database.Database,
  run: string,
  token: string,
) {
  const row = releaseCaptureStatement(db).get(run, token);
  return row === undefined
    ? undefined
    : parseRecord(releaseCaptureRow, row, "run_checkouts");
}

export const CAPTURE_FIELDS = [
  "end_head",
  "ahead",
  "behind",
  "files",
  "committed",
  "working",
  "untracked",
  "patch",
  "patch_bytes",
  "patch_truncated",
  "remote",
  "overlap",
] as const;

const selectStatement = statementVariants();
export function select(db: Database.Database, runId: string, owner?: string) {
  const row = selectStatement(
    `SELECT * FROM run_checkouts WHERE run_id=?${owner ? " AND owner_id=?" : ""}`,
    db,
  ).get(...(owner ? [runId, owner] : [runId]));
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.run_checkouts, row, "run_checkouts");
}
const insertStatement =
  statement(`INSERT OR IGNORE INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,generation,directory,source,branch,base_ref,base_sha,start_head,start_patch,start_untracked_paths,start_dirty,start_untracked,started_at,state,error,summary)
   VALUES(@id,@owner_id,@run_id,@agent_id,@conversation_id,@generation,@directory,@source,@branch,@base_ref,@base_sha,@start_head,@start_patch,@start_untracked_paths,@start_dirty,@start_untracked,@started_at,@state,@error,@summary)`);
export function insert(db: Database.Database, row: Record<string, unknown>) {
  return insertStatement(db).run(row);
}
const updateStatement = statement(
  `UPDATE run_checkouts SET id=@id,state=@state,branch=@branch,base_sha=@base_sha,${CAPTURE_FIELDS.map((f) => `${f}=@${f}`).join(",")},captured_late=@captured_late,summary=@summary,ended_at=@ended_at,error=@error WHERE run_id=@run_id AND capture_token=@token`,
);
export function updateCapture(
  db: Database.Database,
  row: Record<string, unknown>,
) {
  return updateStatement(db).run(row);
}
const reconcileStatement = statementVariants();
export function reconcileCandidates(
  db: Database.Database,
  expired: number,
  TERMINAL_STATES: readonly string[],
) {
  return reconcileStatement(
    `SELECT k.run_id,r.updated_at FROM run_checkouts k JOIN runs r ON r.id=k.run_id
         WHERE k.start_head<>'' AND (k.state='started' OR k.capture_pending=1 OR k.capture_token IS NOT NULL)
           AND (k.capture_token IS NULL OR k.capture_started_at<?)
           AND r.state IN (${TERMINAL_STATES.map(() => "?").join(",")}) LIMIT 20`,
    db,
  )
    .all(expired, ...TERMINAL_STATES)
    .map((row) =>
      parseRecord(
        z.object({ run_id: z.string(), updated_at: z.number() }),
        row,
        "run_checkouts",
      ),
    );
}

const feedSummaryStatement = statement(
  "SELECT summary FROM run_checkouts WHERE run_id=? AND owner_id=?",
);
const feedSummaryRow = QueryRecords.run_checkouts.pick({ summary: true });
export function feedSummary(db: Database.Database, run: string, owner: string) {
  const row = feedSummaryStatement(db).get(run, owner);
  return row === undefined
    ? undefined
    : parseRecord(feedSummaryRow, row, "run_checkouts");
}
