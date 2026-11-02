import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT reservation_id,descriptor,received,complete FROM fleet_mail_files WHERE owner_id=? AND peer_id=? AND message_id=? AND file_id=?",
);
const getRow = QueryRecords.fleet_mail_files.pick({
  reservation_id: true,
  descriptor: true,
  received: true,
  complete: true,
});
export function get(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
  file: string,
) {
  const row = getStatement(db).get(owner, peer, message, file);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_mail_files");
}

const pruneStatement = statement(
  "DELETE FROM fleet_mail_files WHERE expires_at<=? OR EXISTS (\n        SELECT 1 FROM fleet_mail_inbox i\n        WHERE i.owner_id=fleet_mail_files.owner_id AND i.peer_id=fleet_mail_files.peer_id\n          AND i.message_id=fleet_mail_files.message_id AND json_extract(i.admission,'$.state')<>'prepared'\n      )",
);
export function prune(db: Database.Database, now: number) {
  return pruneStatement(db).run(now);
}

const reservedBytesStatement = statement(
  "SELECT COALESCE(sum(size),0) size, COALESCE(sum(CASE WHEN peer_id=? THEN size ELSE 0 END),0) peerSize FROM fleet_mail_files",
);
const reservedBytesRow = z.object({ size: z.number(), peerSize: z.number() });
export function reservedBytes(db: Database.Database, peer: string) {
  const row = reservedBytesStatement(db).get(peer);
  return row === undefined
    ? undefined
    : parseRecord(reservedBytesRow, row, "fleet_mail_files");
}

const insertStatement = statement(
  "INSERT INTO fleet_mail_files(owner_id,peer_id,message_id,file_id,reservation_id,descriptor,size,expires_at) VALUES(?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
  file: string,
  reservation: string,
  descriptor: string,
  size: number,
  expires: number,
) {
  return insertStatement(db).run(
    owner,
    peer,
    message,
    file,
    reservation,
    descriptor,
    size,
    expires,
  );
}

const removeStatement = statement(
  "DELETE FROM fleet_mail_files WHERE owner_id=? AND peer_id=? AND message_id=? AND file_id=?",
);
export function remove(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
  file: string,
) {
  return removeStatement(db).run(owner, peer, message, file);
}

const progressStatement = statement(
  "UPDATE fleet_mail_files SET received=?,complete=? WHERE owner_id=? AND peer_id=? AND message_id=? AND file_id=?",
);
export function progress(
  db: Database.Database,
  received: number,
  complete: number,
  owner: string,
  peer: string,
  message: string,
  file: string,
) {
  return progressStatement(db).run(
    received,
    complete,
    owner,
    peer,
    message,
    file,
  );
}

const removeMessageStatement = statement(
  "DELETE FROM fleet_mail_files WHERE owner_id=? AND peer_id=? AND message_id=?",
);
export function removeMessage(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
) {
  return removeMessageStatement(db).run(owner, peer, message);
}
