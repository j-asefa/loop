import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT INTO fleet_mail_dispatch\n      (mail_id,connection_id,native_generation,native) VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  mail: string,
  connection: string,
  generation: string | null,
  native: number,
) {
  return insertStatement(db).run(mail, connection, generation, native);
}

const getStatement = statement(
  "SELECT * FROM fleet_mail_dispatch WHERE mail_id=?",
);
const getRow = QueryRecords.fleet_mail_dispatch;
export function get(db: Database.Database, mail: string) {
  const row = getStatement(db).get(mail);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_mail_dispatch");
}
