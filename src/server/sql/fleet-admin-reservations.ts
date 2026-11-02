import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const pendingStatement = statement(
  "SELECT operation_id,revision_digest FROM fleet_admin_reservations WHERE owner_id=?",
);
const pendingRow = QueryRecords.fleet_admin_reservations.pick({
  operation_id: true,
  revision_digest: true,
});
export function pending(db: Database.Database, owner: string) {
  const row = pendingStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(pendingRow, row, "fleet_admin_reservations");
}

const existsStatement = statement(
  "SELECT 1 FROM fleet_admin_reservations WHERE owner_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, owner: string) {
  const row = existsStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "fleet_admin_reservations");
}

const insertStatement = statement(
  "INSERT INTO fleet_admin_reservations VALUES(?,?,?,NULL)",
);
export function insert(
  db: Database.Database,
  owner: string,
  operation: string,
  expected: string,
) {
  return insertStatement(db).run(owner, operation, expected);
}

const reserveRevisionStatement = statement(
  "UPDATE fleet_admin_reservations SET revision_digest=? WHERE owner_id=? AND operation_id=? AND expected_head=? AND (revision_digest IS NULL OR revision_digest=?)",
);
export function reserveRevision(
  db: Database.Database,
  revision: string,
  owner: string,
  operation: string,
  expected: string,
  sameRevision: string,
) {
  return reserveRevisionStatement(db).run(
    revision,
    owner,
    operation,
    expected,
    sameRevision,
  );
}

const removeStatement = statement(
  "DELETE FROM fleet_admin_reservations WHERE owner_id=? AND operation_id=?",
);
export function remove(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  return removeStatement(db).run(owner, operation);
}
