import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownerStatement = statement(
  "SELECT owner_id FROM fleet_device_store WHERE singleton=1",
);
const ownerRow = QueryRecords.fleet_device_store.pick({ owner_id: true });
export function owner(db: Database.Database) {
  const row = ownerStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(ownerRow, row, "fleet_device_store");
}

const initializeStatement = statement(
  "INSERT INTO fleet_device_store VALUES(1,?)",
);
export function initialize(db: Database.Database, owner: string) {
  return initializeStatement(db).run(owner);
}
