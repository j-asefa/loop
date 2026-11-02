import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const removeOwnerStatement = statement(
  "DELETE FROM search_index_status WHERE owner_id=?",
);
export function removeOwner(db: Database.Database, owner: string) {
  return removeOwnerStatement(db).run(owner);
}

const configuredStatement = statement(
  "SELECT * FROM search_index_status WHERE owner_id=? AND configuration=?",
);
const configuredRow = QueryRecords.search_index_status;
export function configured(
  db: Database.Database,
  owner: string,
  config: string,
) {
  const row = configuredStatement(db).get(owner, config);
  return row === undefined
    ? undefined
    : parseRecord(configuredRow, row, "search_index_status");
}

const replaceStatement = statement(
  "INSERT OR REPLACE INTO search_index_status VALUES(?,?,?,?,?)",
);
export function replace(
  db: Database.Database,
  owner: string,
  config: string,
  state: string,
  error: string | null,
  updated: number,
) {
  return replaceStatement(db).run(owner, config, state, error, updated);
}
