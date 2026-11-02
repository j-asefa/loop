import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const keysStatement = statement(
  "SELECT public_key,private_key FROM push_config WHERE singleton=1",
);
const keysRow = QueryRecords.push_config.pick({
  public_key: true,
  private_key: true,
});
export function keys(db: Database.Database) {
  const row = keysStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(keysRow, row, "push_config");
}

const insertStatement = statement("INSERT INTO push_config VALUES(1,?,?)");
export function insert(
  db: Database.Database,
  publicKey: string,
  privateKey: string,
) {
  return insertStatement(db).run(publicKey, privateKey);
}
