import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const clearStatement = statement("DELETE FROM fleet_credential_nonces");
export function clear(db: Database.Database) {
  return clearStatement(db).run();
}

const expireStatement = statement(
  "DELETE FROM fleet_credential_nonces WHERE expires_at<=? OR issuer_session<>? OR expires_at_monotonic<=?",
);
export function expire(
  db: Database.Database,
  now: number,
  issuer: string,
  started: number,
) {
  return expireStatement(db).run(now, issuer, started);
}

const existsStatement = statement(
  "SELECT 1 FROM fleet_credential_nonces WHERE nonce_hash=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, hash: string) {
  const row = existsStatement(db).get(hash);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "fleet_credential_nonces");
}

const insertStatement = statement(
  "INSERT INTO fleet_credential_nonces VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  hash: string,
  expires: number,
  issuer: string,
  monotonic: number,
) {
  return insertStatement(db).run(hash, expires, issuer, monotonic);
}
