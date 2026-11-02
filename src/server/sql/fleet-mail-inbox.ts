import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM fleet_mail_inbox WHERE owner_id=? AND peer_id=? AND message_id=?",
);
const getRow = QueryRecords.fleet_mail_inbox;
export function get(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
) {
  const row = getStatement(db).get(owner, peer, message);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_mail_inbox");
}

const settleStatement = statement(
  "UPDATE fleet_mail_inbox SET admission=?,revision=revision+1,settled=1,updated_at=? WHERE owner_id=? AND peer_id=? AND message_id=?",
);
export function settle(
  db: Database.Database,
  admission: string,
  updated: number,
  owner: string,
  peer: string,
  message: string,
) {
  return settleStatement(db).run(admission, updated, owner, peer, message);
}

const admissionStatement = statement(
  "UPDATE fleet_mail_inbox SET admission=?,revision=revision+1,settled=?,updated_at=? WHERE owner_id=? AND peer_id=? AND message_id=?",
);
export function admission(
  db: Database.Database,
  admission: string,
  settled: number,
  updated: number,
  owner: string,
  peer: string,
  message: string,
) {
  return admissionStatement(db).run(
    admission,
    settled,
    updated,
    owner,
    peer,
    message,
  );
}

const pendingStatement = statement(
  "SELECT * FROM fleet_mail_inbox WHERE owner_id=? AND settled=0 LIMIT ?",
);
const pendingRow = QueryRecords.fleet_mail_inbox;
export function pending(db: Database.Database, owner: string, limit: number) {
  return pendingStatement(db)
    .all(owner, limit)
    .map((row) => parseRecord(pendingRow, row, "fleet_mail_inbox"));
}

const pendingCountsStatement = statement(
  "SELECT count(*) n,coalesce(sum(peer_id=?),0) peers FROM fleet_mail_inbox WHERE owner_id=? AND settled=0",
);
const pendingCountsRow = z.object({ n: z.number(), peers: z.number() });
export function pendingCounts(
  db: Database.Database,
  peer: string,
  owner: string,
) {
  const row = pendingCountsStatement(db).get(peer, owner);
  return row === undefined
    ? undefined
    : parseRecord(pendingCountsRow, row, "fleet_mail_inbox");
}

const prepareStatement = statement(
  "INSERT INTO fleet_mail_inbox\n        (owner_id,peer_id,message_id,fleet_id,source_grant_id,destination_grant_id,payload_digest,admission,revision,settled,created_at,updated_at)\n        VALUES(?,?,?,?,?,?,?,?,1,0,?,?)",
);
export function prepare(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
  fleet: string,
  sourceGrant: string,
  destinationGrant: string,
  digest: string,
  admission: string,
  created: number,
  updated: number,
) {
  return prepareStatement(db).run(
    owner,
    peer,
    message,
    fleet,
    sourceGrant,
    destinationGrant,
    digest,
    admission,
    created,
    updated,
  );
}

const insertStatement = statement(
  "INSERT INTO fleet_mail_inbox\n        (owner_id,peer_id,message_id,fleet_id,source_grant_id,destination_grant_id,payload_digest,admission,revision,settled,created_at,updated_at)\n        VALUES(?,?,?,?,?,?,?,?,1,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
  fleet: string,
  sourceGrant: string,
  destinationGrant: string,
  digest: string,
  admission: string,
  settled: number,
  created: number,
  updated: number,
) {
  return insertStatement(db).run(
    owner,
    peer,
    message,
    fleet,
    sourceGrant,
    destinationGrant,
    digest,
    admission,
    settled,
    created,
    updated,
  );
}
