import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const currentStatement = statement(
  "SELECT profile FROM deployment_profile WHERE singleton=1",
);
const currentRow = QueryRecords.deployment_profile.pick({ profile: true });
export function current(db: Database.Database) {
  const row = currentStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(currentRow, row, "deployment_profile");
}
