import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM fleet_mail_outbox WHERE owner_id=? AND message_id=?",
);
const getRow = QueryRecords.fleet_mail_outbox;
export function get(db: Database.Database, owner: string, message: string) {
  const row = getStatement(db).get(owner, message);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_mail_outbox");
}

const dueStatement = statement(
  "SELECT message_id FROM fleet_mail_outbox WHERE owner_id=? AND settled=0 AND retry_at<=? ORDER BY updated_at,message_id LIMIT ?",
);
const dueRow = QueryRecords.fleet_mail_outbox.pick({ message_id: true });
export function due(
  db: Database.Database,
  owner: string,
  time: number,
  limit: number,
) {
  return dueStatement(db)
    .all(owner, time, limit)
    .map((row) => parseRecord(dueRow, row, "fleet_mail_outbox"));
}

const restartStatement = statement(
  "UPDATE fleet_mail_outbox SET retry_at=0 WHERE owner_id=? AND settled=0",
);
export function restart(db: Database.Database, owner: string) {
  return restartStatement(db).run(owner);
}

const attemptsStatement = statement(
  "SELECT attempts FROM fleet_mail_outbox WHERE owner_id=? AND message_id=? AND settled=0",
);
const attemptsRow = QueryRecords.fleet_mail_outbox.pick({ attempts: true });
export function attempts(
  db: Database.Database,
  owner: string,
  message: string,
) {
  const row = attemptsStatement(db).get(owner, message);
  return row === undefined
    ? undefined
    : parseRecord(attemptsRow, row, "fleet_mail_outbox");
}

const retryStatement = statement(
  "UPDATE fleet_mail_outbox SET attempts=?,retry_at=? WHERE owner_id=? AND message_id=? AND settled=0",
);
export function retry(
  db: Database.Database,
  attempts: number,
  retry: number,
  owner: string,
  message: string,
) {
  return retryStatement(db).run(attempts, retry, owner, message);
}

const clearReceiptStatement = statement(
  "UPDATE fleet_mail_outbox SET state='unknown',receipt=NULL,transmitted_at=?,updated_at=? WHERE owner_id=? AND message_id=?",
);
export function clearReceipt(
  db: Database.Database,
  transmitted: number,
  updated: number,
  owner: string,
  message: string,
) {
  return clearReceiptStatement(db).run(transmitted, updated, owner, message);
}

const pendingCountStatement = statement(
  "SELECT count(*) n FROM fleet_mail_outbox WHERE owner_id=? AND settled=0",
);
const pendingCountRow = z.object({ n: z.number() });
export function pendingCount(db: Database.Database, owner: string) {
  const row = pendingCountStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(pendingCountRow, row, "fleet_mail_outbox");
}

const insertStatement = statement(
  "INSERT INTO fleet_mail_outbox\n        (owner_id,message_id,peer_id,fleet_id,source_grant_id,destination_grant_id,payload_digest,envelope,state,created_at,updated_at)\n        VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  message: string,
  peer: string,
  fleet: string,
  sourceGrant: string,
  destinationGrant: string,
  digest: string,
  envelope: string,
  created: number,
  updated: number,
) {
  return insertStatement(db).run(
    owner,
    message,
    peer,
    fleet,
    sourceGrant,
    destinationGrant,
    digest,
    envelope,
    created,
    updated,
  );
}

const markTransmittedStatement = statement(
  "UPDATE fleet_mail_outbox SET state='unknown',transmitted_at=?,updated_at=? WHERE owner_id=? AND message_id=? AND state='pending'",
);
export function markTransmitted(
  db: Database.Database,
  transmitted: number,
  updated: number,
  owner: string,
  message: string,
) {
  return markTransmittedStatement(db).run(transmitted, updated, owner, message);
}

const refusePendingStatement = statement(
  "UPDATE fleet_mail_outbox SET state='refused',local_refusal=?,\n      settled=1,envelope=NULL,updated_at=? WHERE owner_id=? AND message_id=? AND state='pending'",
);
export function refusePending(
  db: Database.Database,
  reason: string,
  updated: number,
  owner: string,
  message: string,
) {
  return refusePendingStatement(db).run(reason, updated, owner, message);
}

const receiptStatement = statement(
  "UPDATE fleet_mail_outbox SET state=?,receipt=?,settled=?,\n        envelope=CASE WHEN ? THEN NULL ELSE envelope END,updated_at=? WHERE owner_id=? AND message_id=?",
);
export function receipt(
  db: Database.Database,
  state: string,
  receipt: string,
  settled: number,
  clearEnvelope: number,
  updated: number,
  owner: string,
  message: string,
) {
  return receiptStatement(db).run(
    state,
    receipt,
    settled,
    clearEnvelope,
    updated,
    owner,
    message,
  );
}
