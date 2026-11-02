import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const replyTargetStatement = statement(
  "SELECT s.id FROM run_steering s\n      JOIN messages m ON m.id=s.message_id AND m.owner_id=s.owner_id\n      WHERE s.owner_id=? AND s.run_id=? AND s.message_id=? AND m.conversation_id=?\n        AND m.role='user' AND json_extract(m.metadata,'$.automation') IS NULL\n        AND s.state IN ('sending','delivered','failed')",
);
const replyTargetRow = QueryRecords.run_steering.pick({ id: true });
export function replyTarget(
  db: Database.Database,
  owner: string,
  run: string,
  message: string,
  conversation: string | null,
) {
  const row = replyTargetStatement(db).get(owner, run, message, conversation);
  return row === undefined
    ? undefined
    : parseRecord(replyTargetRow, row, "run_steering");
}

const stateStatement = statement("SELECT state FROM run_steering WHERE id=?");

const stateRow = QueryRecords.run_steering.pick({ state: true });

export function state(db: Database.Database, id: string | null) {
  const row = stateStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(stateRow, row, "run_steering");
}

const failedMailStatement = statement(
  "SELECT m.content,m.conversation_id,m.metadata,r.state run_state FROM run_steering s JOIN messages m ON m.id=s.message_id JOIN runs r ON r.id=s.run_id WHERE s.id=? AND s.state='failed' AND s.error=?",
);

const failedMailRow = z.object({
  content: z.string(),
  conversation_id: z.string(),
  metadata: z.string(),
  run_state: z.string(),
});

export function failedMail(
  db: Database.Database,
  id: string | null,
  error: string,
) {
  const row = failedMailStatement(db).get(id, error);
  return row === undefined
    ? undefined
    : parseRecord(failedMailRow, row, "run_steering");
}

const setErrorStatement = statement(
  "UPDATE run_steering SET error=? WHERE id=?",
);

export function setError(
  db: Database.Database,
  error: string,
  id: string | null,
) {
  return setErrorStatement(db).run(error, id);
}

const byIdempotencyStatement = statement(
  "SELECT * FROM run_steering WHERE owner_id=? AND idempotency_key=?",
);

const byIdempotencyRow = QueryRecords.run_steering;

export function byIdempotency(
  db: Database.Database,
  owner: string,
  key: string,
) {
  const row = byIdempotencyStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(byIdempotencyRow, row, "run_steering");
}

const insertStatement = statement(
  "INSERT INTO run_steering(id,owner_id,run_id,message_id,idempotency_key,request,created_at) VALUES(?,?,?,?,?,?,?)",
);

export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  run: string,
  message: string,
  key: string,
  request: string,
  created: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    run,
    message,
    key,
    request,
    created,
  );
}

const pendingMessagesStatement = statement(
  "SELECT s.id,s.message_id,m.content,m.metadata FROM run_steering s JOIN messages m ON m.id=s.message_id WHERE s.run_id=? AND s.state='pending' ORDER BY s.created_at,s.rowid",
);

const pendingMessagesRow = QueryRecords.run_steering
  .pick({ id: true, message_id: true })
  .extend({ content: z.string(), metadata: z.string() });

export function pendingMessages(db: Database.Database, run: string) {
  return pendingMessagesStatement(db)
    .all(run)
    .map((row) => parseRecord(pendingMessagesRow, row, "run_steering"));
}

const finishStatement = statement(
  "UPDATE run_steering SET state=?,error=? WHERE id=? AND state IN ('pending','sending')",
);

export function finish(
  db: Database.Database,
  state: string,
  error: string | null,
  id: string,
) {
  return finishStatement(db).run(state, error, id);
}

const markSendingStatement = statement(
  "UPDATE run_steering SET state='sending' WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM runs WHERE id=run_id AND state IN ('running','awaiting_approval'))",
);

export function markSending(db: Database.Database, id: string) {
  return markSendingStatement(db).run(id);
}

const returnPendingStatement = statement(
  "UPDATE run_steering SET state='pending' WHERE id=? AND state='sending'",
);

export function returnPending(db: Database.Database, id: string) {
  return returnPendingStatement(db).run(id);
}

const ownedRunExistsStatement = statement(
  "SELECT 1 FROM run_steering WHERE id=? AND owner_id=? AND run_id=?",
);

const ownedRunExistsRow = z.object({ "1": z.number() });

export function ownedRunExists(
  db: Database.Database,
  id: string,
  owner: string,
  run: string,
) {
  const row = ownedRunExistsStatement(db).get(id, owner, run);
  return row === undefined
    ? undefined
    : parseRecord(ownedRunExistsRow, row, "run_steering");
}
