import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const activeStatement = statement(
  "SELECT * FROM mcp_federation_peers WHERE owner_id=? AND peer_id=? AND revoked_at IS NULL",
);
const activeRow = QueryRecords.mcp_federation_peers;
export function active(db: Database.Database, owner: string, peer: string) {
  const row = activeStatement(db).get(owner, peer);
  return row === undefined
    ? undefined
    : parseRecord(activeRow, row, "mcp_federation_peers");
}

const ownedPeerStatement = statement(
  "SELECT * FROM mcp_federation_peers WHERE owner_id=? AND peer_id=?",
);
const ownedPeerRow = QueryRecords.mcp_federation_peers;
export function ownedPeer(db: Database.Database, owner: string, peer: string) {
  const row = ownedPeerStatement(db).get(owner, peer);
  return row === undefined
    ? undefined
    : parseRecord(ownedPeerRow, row, "mcp_federation_peers");
}

const enrollStatement = statement(
  "INSERT INTO mcp_federation_peers(id,owner_id,peer_id,secret,token_hash,created_at,revoked_at,revoke_synced_at)\n           VALUES(?,?,?,?,?,?,NULL,NULL) ON CONFLICT(owner_id,peer_id) DO UPDATE SET\n           secret=excluded.secret,token_hash=excluded.token_hash,created_at=excluded.created_at,revoked_at=NULL,revoke_synced_at=NULL",
);
export function enroll(
  db: Database.Database,
  id: string,
  owner: string,
  peer: string,
  secret: string,
  hash: string,
  created: number,
) {
  return enrollStatement(db).run(id, owner, peer, secret, hash, created);
}

const revokeStatement = statement(
  "UPDATE mcp_federation_peers SET revoked_at=coalesce(revoked_at,?),\n         revoke_synced_at=CASE WHEN ? THEN ? ELSE revoke_synced_at END,\n         secret=? WHERE owner_id=? AND peer_id=?",
);
export function revoke(
  db: Database.Database,
  time: number,
  synced: number,
  syncTime: number,
  secret: string,
  owner: string,
  peer: string,
) {
  return revokeStatement(db).run(time, synced, syncTime, secret, owner, peer);
}

const byTokenStatement = statement(
  "SELECT * FROM mcp_federation_peers WHERE token_hash=? AND revoked_at IS NULL",
);
const byTokenRow = QueryRecords.mcp_federation_peers;
export function byToken(db: Database.Database, hash: string) {
  const row = byTokenStatement(db).get(hash);
  return row === undefined
    ? undefined
    : parseRecord(byTokenRow, row, "mcp_federation_peers");
}
