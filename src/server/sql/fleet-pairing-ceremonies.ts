import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const cancelPendingStatement = statement(
  "UPDATE fleet_pairing_ceremonies SET state='cancelled' WHERE owner_id=? AND state='pending'",
);
export function cancelPending(db: Database.Database, owner: string) {
  return cancelPendingStatement(db).run(owner);
}

const cancelOtherOriginsStatement = statement(
  "UPDATE fleet_pairing_ceremonies SET state='cancelled' WHERE owner_id=? AND state='pending' AND origin<>?",
);
export function cancelOtherOrigins(
  db: Database.Database,
  owner: string,
  origin: string,
) {
  return cancelOtherOriginsStatement(db).run(owner, origin);
}

const expireStatement = statement(
  "DELETE FROM fleet_pairing_ceremonies WHERE owner_id=? AND state<>'enrollment' AND expires_at<=?",
);
export function expire(db: Database.Database, owner: string, now: number) {
  return expireStatement(db).run(owner, now);
}

const clearCancelledStatement = statement(
  "DELETE FROM fleet_pairing_ceremonies WHERE owner_id=? AND state='cancelled'",
);
export function clearCancelled(db: Database.Database, owner: string) {
  return clearCancelledStatement(db).run(owner);
}

const insertStatement = statement(
  "INSERT INTO fleet_pairing_ceremonies VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  origin: string,
  scope: string,
  head: string | null,
  mode: string,
  device: string | null,
  enrollment: string | null,
  expires: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    origin,
    scope,
    head,
    mode,
    device,
    enrollment,
    expires,
  );
}

const deviceStatement = statement(
  "SELECT * FROM fleet_pairing_ceremonies WHERE owner_id=? AND device_hash=?",
);
const deviceRow = QueryRecords.fleet_pairing_ceremonies;
export function device(db: Database.Database, owner: string, hash: string) {
  const row = deviceStatement(db).get(owner, hash);
  return row === undefined
    ? undefined
    : parseRecord(deviceRow, row, "fleet_pairing_ceremonies");
}

const consumeDeviceStatement = statement(
  "UPDATE fleet_pairing_ceremonies SET state='device' WHERE id=? AND owner_id=?",
);
export function consumeDevice(
  db: Database.Database,
  id: string,
  owner: string,
) {
  return consumeDeviceStatement(db).run(id, owner);
}

const enrollmentStatement = statement(
  "SELECT * FROM fleet_pairing_ceremonies WHERE id=? AND owner_id=? AND enrollment_hash=?",
);
const enrollmentRow = QueryRecords.fleet_pairing_ceremonies;
export function enrollment(
  db: Database.Database,
  id: string,
  owner: string,
  hash: string,
) {
  const row = enrollmentStatement(db).get(id, owner, hash);
  return row === undefined
    ? undefined
    : parseRecord(enrollmentRow, row, "fleet_pairing_ceremonies");
}

const operationExistsStatement = statement(
  "SELECT 1 FROM fleet_pairing_ceremonies WHERE owner_id=? AND operation_id=?",
);
const operationExistsRow = z.object({ "1": z.number() });
export function operationExists(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  const row = operationExistsStatement(db).get(owner, operation);
  return row === undefined
    ? undefined
    : parseRecord(operationExistsRow, row, "fleet_pairing_ceremonies");
}

const consumeEnrollmentStatement = statement(
  "UPDATE fleet_pairing_ceremonies SET state='enrollment',operation_id=?,payload_digest=?,result=? WHERE id=? AND owner_id=?",
);
export function consumeEnrollment(
  db: Database.Database,
  operation: string,
  digest: string,
  result: string,
  id: string,
  owner: string,
) {
  return consumeEnrollmentStatement(db).run(
    operation,
    digest,
    result,
    id,
    owner,
  );
}
