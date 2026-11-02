import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const savedStatement = statement(
  "SELECT machine_id,public_key,private_key FROM fleet_machine_identity WHERE singleton=1",
);
const savedRow = QueryRecords.fleet_machine_identity.pick({
  machine_id: true,
  public_key: true,
  private_key: true,
});
export function saved(db: Database.Database) {
  const row = savedStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(savedRow, row, "fleet_machine_identity");
}
const privateKeyStatement = statement(
  "SELECT private_key FROM fleet_machine_identity WHERE singleton=1",
);
const privateKeyRow = QueryRecords.fleet_machine_identity.pick({
  private_key: true,
});
export function privateKey(db: Database.Database) {
  const row = privateKeyStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(privateKeyRow, row, "fleet_machine_identity");
}
const existsStatement = statement(
  "SELECT 1 FROM fleet_machine_identity WHERE singleton=1",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database) {
  const row = existsStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "fleet_machine_identity");
}
const insertStatement = statement(
  "INSERT INTO fleet_machine_identity(singleton,machine_id,public_key,private_key,created_at) VALUES(1,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  machine: string,
  publicKey: string,
  privateKey: string,
  created: number,
) {
  return insertStatement(db).run(machine, publicKey, privateKey, created);
}
