import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const savedStatement = statement(
  "SELECT request,protocol FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
);
const savedRow = QueryRecords.fleet_distribution_work.pick({
  request: true,
  protocol: true,
});
export function saved(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string,
) {
  const row = savedStatement(db).get(owner, peer, digest);
  return row === undefined
    ? undefined
    : parseRecord(savedRow, row, "fleet_distribution_work");
}

const insertStatement = statement(
  "INSERT OR IGNORE INTO fleet_distribution_work(owner_id,peer_id,directory_digest,request) VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string,
  request: string,
) {
  return insertStatement(db).run(owner, peer, digest, request);
}

const removeStatement = statement(
  "DELETE FROM fleet_distribution_work WHERE owner_id=? AND peer_id=? AND directory_digest=?",
);
export function remove(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string,
) {
  return removeStatement(db).run(owner, peer, digest);
}

const pendingStatement = statement(
  "INSERT INTO fleet_distribution_work(owner_id,peer_id,directory_digest,request,protocol) VALUES(?,?,?,?,'pending') ON CONFLICT(owner_id,peer_id,directory_digest) DO UPDATE SET request=excluded.request,protocol='pending'",
);
export function pending(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string,
  request: string,
) {
  return pendingStatement(db).run(owner, peer, digest, request);
}
