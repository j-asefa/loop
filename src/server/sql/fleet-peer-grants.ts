import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const deactivateStatement = statement(
  "UPDATE fleet_peer_grants SET active=0 WHERE owner_id=?",
);
export function deactivate(db: Database.Database, owner: string) {
  return deactivateStatement(db).run(owner);
}

const activeStatement = statement(
  "SELECT * FROM fleet_peer_grants WHERE owner_id=? AND peer_id=? AND fleet_id=? AND grant_id=? AND active=1",
);
const activeRow = QueryRecords.fleet_peer_grants;
export function active(
  db: Database.Database,
  owner: string,
  peer: string,
  fleet: string,
  grant: string,
) {
  const row = activeStatement(db).get(owner, peer, fleet, grant);
  return row === undefined
    ? undefined
    : parseRecord(activeRow, row, "fleet_peer_grants");
}

const installStatement = statement(
  "INSERT INTO fleet_peer_grants VALUES(?,?,?,?,?,?,?,?,?,1)\n        ON CONFLICT(owner_id,grant_id,peer_id) DO UPDATE SET public_key=excluded.public_key,\n        fleet_id=excluded.fleet_id,directory_digest=excluded.directory_digest,epoch=excluded.epoch,\n        revision=excluded.revision,scope=excluded.scope,active=1",
);
export function install(
  db: Database.Database,
  owner: string,
  grant: string,
  peer: string,
  publicKey: string,
  fleet: string,
  digest: string,
  epoch: number,
  revision: number,
  scope: string,
) {
  return installStatement(db).run(
    owner,
    grant,
    peer,
    publicKey,
    fleet,
    digest,
    epoch,
    revision,
    scope,
  );
}
