import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertOutgoingStatement = statement(
  "INSERT INTO fleet_mail_records\n      (mail_id,owner_id,peer_id,message_id,direction,sender_name) VALUES(?,?,?,?,'outgoing',?)",
);
export function insertOutgoing(
  db: Database.Database,
  mail: string,
  owner: string,
  peer: string,
  message: string,
  sender: string,
) {
  return insertOutgoingStatement(db).run(mail, owner, peer, message, sender);
}

const outgoingSenderStatement = statement(
  "SELECT sender_name FROM fleet_mail_records WHERE mail_id=? AND direction='outgoing'",
);
const outgoingSenderRow = QueryRecords.fleet_mail_records.pick({
  sender_name: true,
});
export function outgoingSender(db: Database.Database, mail: string) {
  const row = outgoingSenderStatement(db).get(mail);
  return row === undefined
    ? undefined
    : parseRecord(outgoingSenderRow, row, "fleet_mail_records");
}

const projectedStatement = statement(
  "UPDATE fleet_mail_records SET projection_pending=0 WHERE owner_id=? AND mail_id=?",
);
export function projected(db: Database.Database, owner: string, mail: string) {
  return projectedStatement(db).run(owner, mail);
}

const pendingProjectionsStatement = statement(
  "SELECT mail_id FROM fleet_mail_records\n      WHERE owner_id=? AND projection_pending=1 AND direction='outgoing'\n      ORDER BY mail_id LIMIT 100",
);
const pendingProjectionsRow = QueryRecords.fleet_mail_records.pick({
  mail_id: true,
});
export function pendingProjections(db: Database.Database, owner: string) {
  return pendingProjectionsStatement(db)
    .all(owner)
    .map((row) =>
      parseRecord(pendingProjectionsRow, row, "fleet_mail_records"),
    );
}

const incomingSenderStatement = statement(
  "SELECT sender_name FROM fleet_mail_records WHERE mail_id=? AND owner_id=? AND peer_id=? AND direction='incoming'",
);
const incomingSenderRow = QueryRecords.fleet_mail_records.pick({
  sender_name: true,
});
export function incomingSender(
  db: Database.Database,
  mail: string,
  owner: string,
  peer: string,
) {
  const row = incomingSenderStatement(db).get(mail, owner, peer);
  return row === undefined
    ? undefined
    : parseRecord(incomingSenderRow, row, "fleet_mail_records");
}

const insertIncomingStatement = statement(
  "INSERT INTO fleet_mail_records(mail_id,owner_id,peer_id,message_id,direction,sender_name) VALUES(?,?,?,?,'incoming',?)",
);
export function insertIncoming(
  db: Database.Database,
  mail: string,
  owner: string,
  peer: string,
  message: string,
  sender: string,
) {
  return insertIncomingStatement(db).run(mail, owner, peer, message, sender);
}

const ownerIncomingSenderStatement = statement(
  "SELECT sender_name FROM fleet_mail_records WHERE owner_id=? AND mail_id=? AND peer_id=? AND direction='incoming'",
);
const ownerIncomingSenderRow = QueryRecords.fleet_mail_records.pick({
  sender_name: true,
});
export function ownerIncomingSender(
  db: Database.Database,
  owner: string,
  mail: string,
  peer: string,
) {
  const row = ownerIncomingSenderStatement(db).get(owner, mail, peer);
  return row === undefined
    ? undefined
    : parseRecord(ownerIncomingSenderRow, row, "fleet_mail_records");
}
