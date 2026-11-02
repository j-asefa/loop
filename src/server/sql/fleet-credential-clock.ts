import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const currentStatement = statement(
  "SELECT observed_at FROM fleet_credential_clock WHERE singleton=1",
);
const currentRow = QueryRecords.fleet_credential_clock.pick({
  observed_at: true,
});
export function current(db: Database.Database) {
  const row = currentStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(currentRow, row, "fleet_credential_clock");
}

const setStatement = statement(
  "INSERT INTO fleet_credential_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET observed_at=excluded.observed_at",
);
export function set(db: Database.Database, now: number) {
  return setStatement(db).run(now);
}

const observeStatement = statement(
  "INSERT INTO fleet_credential_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET observed_at=max(observed_at,excluded.observed_at)",
);
export function observe(db: Database.Database, observed: number) {
  return observeStatement(db).run(observed);
}
