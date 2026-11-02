import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const restartPendingStatement = statement(
  "UPDATE fleet_distribution SET next_attempt=0 WHERE owner_id=? AND state='pending'",
);
export function restartPending(db: Database.Database, owner: string) {
  return restartPendingStatement(db).run(owner);
}

const retryPendingStatement = statement(
  "UPDATE fleet_distribution SET attempts=0,next_attempt=? WHERE owner_id=? AND peer_id=? AND directory_digest=? AND state='pending'",
);
export function retryPending(
  db: Database.Database,
  next: number,
  owner: string,
  peer: string,
  digest: string,
) {
  return retryPendingStatement(db).run(next, owner, peer, digest);
}

const stateStatement = statement(
  "SELECT state FROM fleet_distribution WHERE owner_id=? AND peer_id=? AND directory_digest=?",
);
const stateRow = QueryRecords.fleet_distribution.pick({ state: true });
export function state(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string,
) {
  const row = stateStatement(db).get(owner, peer, digest);
  return row === undefined
    ? undefined
    : parseRecord(stateRow, row, "fleet_distribution");
}

const retryStatement = statement(
  "UPDATE fleet_distribution SET attempts=0,next_attempt=? WHERE owner_id=? AND peer_id=? AND directory_digest=?",
);
export function retry(
  db: Database.Database,
  next: number,
  owner: string,
  peer: string,
  digest: string,
) {
  return retryStatement(db).run(next, owner, peer, digest);
}

const recordAttemptStatement = statement(
  "UPDATE fleet_distribution SET state=?,attempts=attempts+1,next_attempt=? WHERE owner_id=? AND peer_id=? AND directory_digest=? AND state='pending'",
);
export function recordAttempt(
  db: Database.Database,
  state: string,
  retry: number,
  owner: string,
  peer: string,
  digest: string,
) {
  return recordAttemptStatement(db).run(state, retry, owner, peer, digest);
}

const dueStatement = statement(
  "SELECT d.peer_id,d.directory_digest,d.attempts FROM fleet_distribution d\n      JOIN fleet_directory_history h ON h.owner_id=d.owner_id AND h.digest=d.directory_digest\n      WHERE d.owner_id=? AND d.state='pending' AND d.next_attempt<=?\n        AND NOT EXISTS(SELECT 1 FROM fleet_distribution newer JOIN fleet_directory_history n ON n.owner_id=newer.owner_id AND n.digest=newer.directory_digest WHERE newer.owner_id=d.owner_id AND newer.peer_id=d.peer_id AND newer.state='pending' AND n.rowid>h.rowid)\n      ORDER BY d.next_attempt,h.rowid,d.peer_id LIMIT 2",
);
const dueRow = QueryRecords.fleet_distribution.pick({
  peer_id: true,
  directory_digest: true,
  attempts: true,
});
export function due(db: Database.Database, owner: string, now: number) {
  return dueStatement(db)
    .all(owner, now)
    .map((row) => parseRecord(dueRow, row, "fleet_distribution"));
}

const latestPageStatement = statement(
  "\n      SELECT d.peer_id,d.directory_digest,d.state,d.attempts\n      FROM fleet_distribution d\n      JOIN fleet_directory_history h ON h.owner_id=d.owner_id AND h.digest=d.directory_digest\n      WHERE d.owner_id=? AND (? IS NULL OR d.peer_id>?)\n        AND NOT EXISTS (\n          SELECT 1 FROM fleet_distribution newer\n          JOIN fleet_directory_history n ON n.owner_id=newer.owner_id AND n.digest=newer.directory_digest\n          WHERE newer.owner_id=d.owner_id AND newer.peer_id=d.peer_id AND n.rowid>h.rowid\n        )\n      ORDER BY d.peer_id LIMIT 51\n    ",
);
const latestPageRow = QueryRecords.fleet_distribution.pick({
  peer_id: true,
  directory_digest: true,
  state: true,
  attempts: true,
});
export function latestPage(
  db: Database.Database,
  owner: string,
  cursor: string | null,
  sameCursor: string | null,
) {
  return latestPageStatement(db)
    .all(owner, cursor, sameCursor)
    .map((row) => parseRecord(latestPageRow, row, "fleet_distribution"));
}

const restartStatement = statement(
  "UPDATE fleet_distribution SET state='pending',next_attempt=0 WHERE owner_id=? AND peer_id=? AND directory_digest=?",
);
export function restart(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string,
) {
  return restartStatement(db).run(owner, peer, digest);
}

const unackedStatement = statement(
  "SELECT directory_digest,count(DISTINCT peer_id) n FROM fleet_distribution WHERE owner_id=? AND state<>'acked' GROUP BY directory_digest",
);
const unackedRow = z.object({
  directory_digest: QueryRecords.fleet_distribution.shape.directory_digest,
  n: z.number(),
});
export function unacked(db: Database.Database, owner: string) {
  return unackedStatement(db)
    .all(owner)
    .map((row) => parseRecord(unackedRow, row, "fleet_distribution"));
}

const enqueueStatement = statement(
  "INSERT OR IGNORE INTO fleet_distribution(owner_id,peer_id,directory_digest,state) VALUES(?,?,?,'pending')",
);
export function enqueue(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string,
) {
  return enqueueStatement(db).run(owner, peer, digest);
}

const acknowledgeStatement = statement(
  "UPDATE fleet_distribution SET state='acked' WHERE owner_id=? AND peer_id=? AND directory_digest=?",
);
export function acknowledge(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string | null,
) {
  return acknowledgeStatement(db).run(owner, peer, digest);
}

const acknowledgePendingStatement = statement(
  "UPDATE fleet_distribution SET state='acked',next_attempt=0 WHERE owner_id=? AND peer_id=? AND directory_digest=? AND state='pending'",
);
export function acknowledgePending(
  db: Database.Database,
  owner: string,
  peer: string,
  digest: string,
) {
  return acknowledgePendingStatement(db).run(owner, peer, digest);
}
