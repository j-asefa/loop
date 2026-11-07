import type Database from "better-sqlite3";
import { z } from "zod";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsStatement = statement(
  "SELECT 1 FROM import_messages WHERE owner_id=? AND provider=? AND external_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(
  db: Database.Database,
  owner: string,
  provider: string,
  external: string,
) {
  const row = existsStatement(db).get(owner, provider, external);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "import_messages");
}

const insertStatement = statement(
  "INSERT INTO import_messages VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  provider: string,
  external: string,
  message: string,
) {
  return insertStatement(db).run(owner, provider, external, message);
}
