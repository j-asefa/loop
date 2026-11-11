import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const validStatement = statement(
  "SELECT 1 FROM oauth_states WHERE state=? AND owner_id=? AND expires_at>?",
);
const validRow = z.object({ "1": z.number() });
export function valid(
  db: Database.Database,
  state: unknown,
  owner: string,
  time: number,
) {
  const row = validStatement(db).get(state, owner, time);
  return row === undefined
    ? undefined
    : parseRecord(validRow, row, "oauth_states");
}

const removeConnectionStatement = statement(
  "DELETE FROM oauth_states WHERE connection_id=?",
);
export function removeConnection(db: Database.Database, connection: string) {
  return removeConnectionStatement(db).run(connection);
}

const removeConnectionOrExpiredStatement = statement(
  "DELETE FROM oauth_states WHERE connection_id=? OR expires_at<?",
);
export function removeConnectionOrExpired(
  db: Database.Database,
  connection: string,
  time: number,
) {
  return removeConnectionOrExpiredStatement(db).run(connection, time);
}

const insertStatement = statement("INSERT INTO oauth_states VALUES(?,?,?,?)");
export function insert(
  db: Database.Database,
  state: string,
  owner: string,
  connection: string,
  expires: number,
) {
  return insertStatement(db).run(state, owner, connection, expires);
}

const activeStatement = statement(
  "SELECT * FROM oauth_states WHERE state=? AND owner_id=? AND expires_at>?",
);

export function active(
  db: Database.Database,
  state: string,
  owner: string,
  time: number,
) {
  const row = activeStatement(db).get(state, owner, time);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.oauth_states, row, "oauth_states");
}

const removeStatement = statement("DELETE FROM oauth_states WHERE state=?");
export function remove(db: Database.Database, state: string) {
  return removeStatement(db).run(state);
}
