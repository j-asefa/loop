import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const installStatement = statement(
  "INSERT INTO fleet_credential_issuer VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET issuer_session=excluded.issuer_session",
);
export function install(db: Database.Database, issuer: string) {
  return installStatement(db).run(issuer);
}

const currentStatement = statement(
  "SELECT issuer_session FROM fleet_credential_issuer WHERE singleton=1",
);
const currentRow = QueryRecords.fleet_credential_issuer.pick({
  issuer_session: true,
});
export function current(db: Database.Database) {
  const row = currentStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(currentRow, row, "fleet_credential_issuer");
}
