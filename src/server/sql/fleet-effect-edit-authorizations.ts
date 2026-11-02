import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT OR IGNORE INTO fleet_effect_edit_authorizations VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  kind: string,
  effect: string,
  command: string,
  grant: string,
) {
  return insertStatement(db).run(owner, kind, effect, command, grant);
}

const removeStatement = statement(
  "DELETE FROM fleet_effect_edit_authorizations WHERE owner_id=? AND effect_kind=? AND effect_id=? AND command_id=?",
);
export function remove(
  db: Database.Database,
  owner: string,
  kind: string,
  effect: string,
  command: string,
) {
  return removeStatement(db).run(owner, kind, effect, command);
}
