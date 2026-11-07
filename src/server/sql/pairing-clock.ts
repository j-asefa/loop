import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const currentStatement = statement(
  "SELECT observed_at FROM pairing_clock WHERE singleton=1",
);
const currentRow = QueryRecords.pairing_clock.pick({ observed_at: true });
export function current(db: Database.Database) {
  const row = currentStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(currentRow, row, "pairing_clock");
}

const observeStatement = statement(
  "INSERT INTO pairing_clock VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET observed_at=max(observed_at,excluded.observed_at)",
);
export function observe(db: Database.Database, wall: number) {
  return observeStatement(db).run(wall);
}
