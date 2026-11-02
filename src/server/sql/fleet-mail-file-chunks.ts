import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const forFileStatement = statement(
  "SELECT bytes FROM fleet_mail_file_chunks WHERE owner_id=? AND peer_id=? AND message_id=? AND file_id=? ORDER BY offset",
);
const forFileRow = QueryRecords.fleet_mail_file_chunks.pick({ bytes: true });
export function forFile(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
  file: string,
) {
  return forFileStatement(db)
    .all(owner, peer, message, file)
    .map((row) => parseRecord(forFileRow, row, "fleet_mail_file_chunks"));
}

const getStatement = statement(
  "SELECT bytes FROM fleet_mail_file_chunks WHERE owner_id=? AND peer_id=? AND message_id=? AND file_id=? AND offset=?",
);
const getRow = QueryRecords.fleet_mail_file_chunks.pick({ bytes: true });
export function get(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
  file: string,
  offset: number,
) {
  const row = getStatement(db).get(owner, peer, message, file, offset);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_mail_file_chunks");
}

const insertStatement = statement(
  "INSERT INTO fleet_mail_file_chunks VALUES(?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  peer: string,
  message: string,
  file: string,
  offset: number,
  bytes: Buffer,
) {
  return insertStatement(db).run(owner, peer, message, file, offset, bytes);
}
