import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const grantStatement = statement(
  "SELECT grant_context FROM fleet_mail_effects WHERE mail_id=? AND owner_id=?",
);
const grantRow = QueryRecords.fleet_mail_effects.pick({ grant_context: true });
export function grant(db: Database.Database, mail: string, owner: string) {
  const row = grantStatement(db).get(mail, owner);
  return row === undefined
    ? undefined
    : parseRecord(grantRow, row, "fleet_mail_effects");
}

const insertStatement = statement(
  "INSERT INTO fleet_mail_effects VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  mail: string,
  owner: string,
  command: string,
  grant: string,
) {
  return insertStatement(db).run(mail, owner, command, grant);
}
