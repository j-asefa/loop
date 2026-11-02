import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const clearStatement = statement("DELETE FROM fleet_credentials");
export function clear(db: Database.Database) {
  return clearStatement(db).run();
}

const expireStatement = statement(
  "DELETE FROM fleet_credentials WHERE expires_at<=?",
);
export function expire(db: Database.Database, now: number) {
  return expireStatement(db).run(now);
}

const countStatement = statement("SELECT count(*) n FROM fleet_credentials");
const countRow = z.object({ n: z.number() });
export function count(db: Database.Database) {
  const row = countStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(countRow, row, "fleet_credentials");
}

const peerCountStatement = statement(
  "SELECT count(*) n FROM fleet_credentials WHERE owner_id=? AND peer_id=?",
);
const peerCountRow = z.object({ n: z.number() });
export function peerCount(db: Database.Database, owner: string, peer: string) {
  const row = peerCountStatement(db).get(owner, peer);
  return row === undefined
    ? undefined
    : parseRecord(peerCountRow, row, "fleet_credentials");
}

const insertStatement = statement(
  "INSERT INTO fleet_credentials VALUES(?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  hash: string,
  owner: string,
  peer: string,
  context: string,
  issued: number,
  expires: number,
  observed: number,
) {
  return insertStatement(db).run(
    hash,
    owner,
    peer,
    context,
    issued,
    expires,
    observed,
  );
}

const getStatement = statement(
  "SELECT * FROM fleet_credentials WHERE token_hash=?",
);
const getRow = QueryRecords.fleet_credentials;
export function get(db: Database.Database, hash: string) {
  const row = getStatement(db).get(hash);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_credentials");
}

const removeStatement = statement(
  "DELETE FROM fleet_credentials WHERE token_hash=?",
);
export function remove(db: Database.Database, hash: string) {
  return removeStatement(db).run(hash);
}

const observeStatement = statement(
  "UPDATE fleet_credentials SET observed_at=? WHERE token_hash=?",
);
export function observe(db: Database.Database, wall: number, hash: string) {
  return observeStatement(db).run(wall, hash);
}
