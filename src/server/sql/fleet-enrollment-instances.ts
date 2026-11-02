import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const installStatement = statement(
  "INSERT INTO fleet_enrollment_instances VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET instance_id=excluded.instance_id",
);
export function install(
  db: Database.Database,
  owner: string,
  instance: string,
) {
  return installStatement(db).run(owner, instance);
}

const existsStatement = statement(
  "SELECT 1 FROM fleet_enrollment_instances WHERE owner_id=? AND instance_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, owner: string, instance: string) {
  const row = existsStatement(db).get(owner, instance);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "fleet_enrollment_instances");
}
