import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const previousStatement = statement(
  "SELECT previous_source FROM pi_package_recovery WHERE owner_id=? AND project=? AND scope=? AND source=?",
);
const previousRow = QueryRecords.pi_package_recovery.pick({
  previous_source: true,
});
export function previous(
  db: Database.Database,
  owner: string,
  project: string,
  scope: string,
  source: string,
) {
  const row = previousStatement(db).get(owner, project, scope, source);
  return row === undefined
    ? undefined
    : parseRecord(previousRow, row, "pi_package_recovery");
}

const removeStatement = statement(
  "DELETE FROM pi_package_recovery WHERE owner_id=? AND project=? AND scope=? AND source=?",
);
export function remove(
  db: Database.Database,
  owner: string,
  project: string,
  scope: string,
  source: string,
) {
  return removeStatement(db).run(owner, project, scope, source);
}

const upsertStatement = statement(
  "INSERT INTO pi_package_recovery(owner_id,project,scope,source,previous_source,saved_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,project,scope,source) DO UPDATE SET previous_source=excluded.previous_source,saved_at=excluded.saved_at",
);
export function upsert(
  db: Database.Database,
  owner: string,
  project: string,
  scope: string,
  source: string,
  previous: string,
  saved: number,
) {
  return upsertStatement(db).run(
    owner,
    project,
    scope,
    source,
    previous,
    saved,
  );
}
