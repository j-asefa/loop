import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import type Database from "better-sqlite3";
import { statement } from "./statement.js";
const insertStatement = statement(
  "INSERT OR IGNORE INTO fleet_removal_history VALUES(?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  peer: string,
  publicKey: string,
  fleet: string,
  digest: string,
  parent: string | null,
) {
  return insertStatement(db).run(owner, peer, publicKey, fleet, digest, parent);
}

const forPeerStatement = statement(
  "SELECT digest,parent_digest FROM fleet_removal_history WHERE owner_id=? AND peer_id=? AND public_key=? AND fleet_id=? ORDER BY rowid DESC LIMIT 128",
);
const forPeerRow = QueryRecords.fleet_removal_history.pick({
  digest: true,
  parent_digest: true,
});
export function forPeer(
  db: Database.Database,
  owner: string,
  peer: string,
  publicKey: string,
  fleet: string,
) {
  return forPeerStatement(db)
    .all(owner, peer, publicKey, fleet)
    .map((row) => parseRecord(forPeerRow, row, "fleet_removal_history"));
}
