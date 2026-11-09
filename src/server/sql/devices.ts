import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement("INSERT INTO devices VALUES(?,?,?,?,?,?,?)");
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
  "SELECT id,name,hash,csrf,expires,max_expires AS maxExpires FROM devices WHERE owner_id=?",
);
const listRow = QueryRecords.devices
  .pick({ id: true, name: true, hash: true, csrf: true, expires: true })
  .extend({ maxExpires: QueryRecords.devices.shape.max_expires });
export function list(db: Database.Database, owner: string) {
  return listStatement(db)
    .all(owner)
    .map((row) => parseRecord(listRow, row, "devices"));
}

const byIdStatement = statement(
  "SELECT id,name,hash,csrf,expires,max_expires AS maxExpires FROM devices WHERE owner_id=? AND id=?",
);
const byIdRow = QueryRecords.devices
  .pick({ id: true, name: true, hash: true, csrf: true, expires: true })
  .extend({ maxExpires: QueryRecords.devices.shape.max_expires });
export function byId(db: Database.Database, owner: string, id: string) {
  const row = byIdStatement(db).get(owner, id);
  return row === undefined ? undefined : parseRecord(byIdRow, row, "devices");
}

const byHashStatement = statement(
  "SELECT id,name,hash,csrf,expires,max_expires AS maxExpires FROM devices WHERE owner_id=? AND hash=?",
);
const byHashRow = QueryRecords.devices
  .pick({ id: true, name: true, hash: true, csrf: true, expires: true })
  .extend({ maxExpires: QueryRecords.devices.shape.max_expires });
export function byHash(db: Database.Database, owner: string, hash: string) {
  const row = byHashStatement(db).get(owner, hash);
  return row === undefined ? undefined : parseRecord(byHashRow, row, "devices");
}

const renewStatement = statement(
  "UPDATE devices SET expires=max(expires,@expires) WHERE owner_id=@owner AND id=@id AND hash=@hash AND expires>@now AND max_expires>@now",
);
export function renew(
  db: Database.Database,
  expires: number,
  owner: string,
  id: string,
  hash: string,
  now: number,
) {
  return renewStatement(db).run({ expires, owner, id, hash, now });
}

const removeStatement = statement(
  "DELETE FROM devices WHERE owner_id=? AND id=?",
);
export function remove(db: Database.Database, owner: string, id: string) {
  return removeStatement(db).run(owner, id);
}

const expireStatement = statement(
  "DELETE FROM devices WHERE owner_id=@owner AND (expires<=@now OR max_expires<=@now)",
);
export function expire(db: Database.Database, owner: string, now: number) {
  return expireStatement(db).run({ owner, now });
}

const countStatement = statement(
  "SELECT count(*) n FROM devices WHERE owner_id=?",
);
const countRow = z.object({ n: z.number() });
export function count(db: Database.Database, owner: string) {
  const row = countStatement(db).get(owner);
  return row === undefined ? undefined : parseRecord(countRow, row, "devices");
}
