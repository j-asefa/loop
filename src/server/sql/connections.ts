import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
export const LIVE_INPUT_HARNESSES = new Set(["codex", "claude", "pi", "muse"]);

// Callers qualify metadata through the connections alias c.
export const NATIVE_CONNECTION_SQL =
  "json_extract(c.metadata,'$.loop55Harness') IS NOT NULL";

const ownerConnectionStatement = statement(
  "SELECT * FROM connections WHERE owner_id=? AND id=?",
);
const ownerConnectionRow = QueryRecords.connections;
export function ownerConnection(
  db: Database.Database,
  owner: string,
  connection: string | null,
) {
  const row = ownerConnectionStatement(db).get(owner, connection);
  return row === undefined
    ? undefined
    : parseRecord(ownerConnectionRow, row, "connections");
}

const existsOwnedStatement = statement(
  "SELECT 1 FROM connections WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(
  db: Database.Database,
  connection: string,
  owner: string,
) {
  const row = existsOwnedStatement(db).get(connection, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "connections");
}
