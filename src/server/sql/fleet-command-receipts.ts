import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
);
const getRow = QueryRecords.fleet_command_receipts;
export function get(db: Database.Database, owner: string, command: string) {
  const row = getStatement(db).get(owner, command);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_command_receipts");
}

const refuseStatement = statement(
  "INSERT INTO fleet_command_receipts(owner_id,peer_id,command_id,fleet_id,grant_id,operation,payload_digest,state,result,created_at,updated_at,command_tag) VALUES(?,?,?,?,?,?,?,'refused',NULL,?,?,?)",
);
export function refuse(
  db: Database.Database,
  owner: string,
  peer: string,
  command: string,
  fleet: string,
  grant: string,
  operation: string,
  digest: string,
  created: number,
  updated: number,
  tag: string | null,
) {
  return refuseStatement(db).run(
    owner,
    peer,
    command,
    fleet,
    grant,
    operation,
    digest,
    created,
    updated,
    tag,
  );
}

const startStatement = statement(
  "INSERT INTO fleet_command_receipts(owner_id,peer_id,command_id,fleet_id,grant_id,operation,payload_digest,state,result,created_at,updated_at,command_tag) VALUES(?,?,?,?,?,?,?,'started',NULL,?,?,?)",
);
export function start(
  db: Database.Database,
  owner: string,
  peer: string,
  command: string,
  fleet: string,
  grant: string,
  operation: string,
  digest: string,
  created: number,
  updated: number,
  tag: string | null,
) {
  return startStatement(db).run(
    owner,
    peer,
    command,
    fleet,
    grant,
    operation,
    digest,
    created,
    updated,
    tag,
  );
}

const completeStatement = statement(
  "UPDATE fleet_command_receipts SET state='completed',result=?,updated_at=? WHERE owner_id=? AND peer_id=? AND command_id=? AND state='started'",
);
export function complete(
  db: Database.Database,
  result: string | null,
  updated: number,
  owner: string,
  peer: string,
  command: string,
) {
  return completeStatement(db).run(result, updated, owner, peer, command);
}

const pruneResultsStatement = statement(
  "UPDATE fleet_command_receipts SET result=NULL WHERE owner_id=? AND result IS NOT NULL\n            AND rowid NOT IN (SELECT rowid FROM fleet_command_receipts WHERE owner_id=? AND result IS NOT NULL\n            ORDER BY updated_at DESC,rowid DESC LIMIT 64)",
);
export function pruneResults(
  db: Database.Database,
  owner: string,
  retainedOwner: string,
) {
  return pruneResultsStatement(db).run(owner, retainedOwner);
}

const finishStatement = statement(
  "UPDATE fleet_command_receipts SET state=?,updated_at=? WHERE owner_id=? AND peer_id=? AND command_id=? AND state='started'",
);
export function finish(
  db: Database.Database,
  state: string,
  updated: number,
  owner: string,
  peer: string,
  command: string,
) {
  return finishStatement(db).run(state, updated, owner, peer, command);
}
