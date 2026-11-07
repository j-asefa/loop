import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const enabledStatement = statement(
  "SELECT enabled FROM memory_policy WHERE owner_id=? AND scope=?",
);
const enabledRow = QueryRecords.memory_policy.pick({ enabled: true });
export function enabled(db: Database.Database, owner: string, scope: string) {
  const row = enabledStatement(db).get(owner, scope);
  return row === undefined
    ? undefined
    : parseRecord(enabledRow, row, "memory_policy");
}

const forOwnerStatement = statement(
  "SELECT scope,enabled FROM memory_policy WHERE owner_id=?",
);
const forOwnerRow = QueryRecords.memory_policy.pick({
  scope: true,
  enabled: true,
});
export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(forOwnerRow, row, "memory_policy"));
}

const setStatement = statement(
  "INSERT INTO memory_policy VALUES(?,?,?) ON CONFLICT(owner_id,scope) DO UPDATE SET enabled=excluded.enabled",
);
export function set(
  db: Database.Database,
  owner: string,
  scope: string,
  enabled: number,
) {
  return setStatement(db).run(owner, scope, enabled);
}
