import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT INTO fleet_devices VALUES(?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  hash: string,
  csrf: string,
  expires: number,
  maximum: number,
) {
  return insertStatement(db).run(id, owner, name, hash, csrf, expires, maximum);
}

const listStatement = statement(
  "SELECT id,name,hash,csrf,expires,max_expires AS maxExpires FROM fleet_devices WHERE owner_id=?",
);
const listRow = QueryRecords.fleet_devices
  .pick({ id: true, name: true, hash: true, csrf: true, expires: true })
  .extend({ maxExpires: QueryRecords.fleet_devices.shape.max_expires });
export function list(db: Database.Database, owner: string) {
  return listStatement(db)
    .all(owner)
    .map((row) => parseRecord(listRow, row, "fleet_devices"));
}

const byIdStatement = statement(
  "SELECT id,name,hash,csrf,expires,max_expires AS maxExpires FROM fleet_devices WHERE owner_id=? AND id=?",
);
const byIdRow = QueryRecords.fleet_devices
  .pick({ id: true, name: true, hash: true, csrf: true, expires: true })
  .extend({ maxExpires: QueryRecords.fleet_devices.shape.max_expires });
export function byId(db: Database.Database, owner: string, id: string) {
  const row = byIdStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(byIdRow, row, "fleet_devices");
}

const byHashStatement = statement(
  "SELECT id,name,hash,csrf,expires,max_expires AS maxExpires FROM fleet_devices WHERE owner_id=? AND hash=?",
);
const byHashRow = QueryRecords.fleet_devices
  .pick({ id: true, name: true, hash: true, csrf: true, expires: true })
  .extend({ maxExpires: QueryRecords.fleet_devices.shape.max_expires });
export function byHash(db: Database.Database, owner: string, hash: string) {
  const row = byHashStatement(db).get(owner, hash);
  return row === undefined
    ? undefined
    : parseRecord(byHashRow, row, "fleet_devices");
}

const renewStatement = statement(
  "UPDATE fleet_devices SET expires=max(expires,?) WHERE owner_id=? AND id=? AND hash=? AND expires>? AND max_expires>?",
);
export function renew(
  db: Database.Database,
  expires: number,
  owner: string,
  id: string,
  hash: string,
  now: number,
  maximumNow: number,
) {
  return renewStatement(db).run(expires, owner, id, hash, now, maximumNow);
}

const removeStatement = statement(
  "DELETE FROM fleet_devices WHERE owner_id=? AND id=?",
);
export function remove(db: Database.Database, owner: string, id: string) {
  return removeStatement(db).run(owner, id);
}

const expireStatement = statement(
  "DELETE FROM fleet_devices WHERE owner_id=? AND (expires<=? OR max_expires<=?)",
);
export function expire(
  db: Database.Database,
  owner: string,
  now: number,
  maximumNow: number,
) {
  return expireStatement(db).run(owner, now, maximumNow);
}

const countStatement = statement(
  "SELECT count(*) n FROM fleet_devices WHERE owner_id=?",
);
const countRow = z.object({ n: z.number() });
export function count(db: Database.Database, owner: string) {
  const row = countStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(countRow, row, "fleet_devices");
}
