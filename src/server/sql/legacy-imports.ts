import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const digestStatement = statement(
  "SELECT digest FROM legacy_imports WHERE path=?",
);
const digestRow = QueryRecords.legacy_imports.pick({ digest: true });
export function digest(db: Database.Database, path: string) {
  const row = digestStatement(db).get(path);
  return row === undefined
    ? undefined
    : parseRecord(digestRow, row, "legacy_imports");
}

const insertStatement = statement("INSERT INTO legacy_imports VALUES(?,?,?,?)");
export function insert(
  db: Database.Database,
  path: string,
  conversation: string,
  digest: string,
  created: number,
) {
  return insertStatement(db).run(path, conversation, digest, created);
}
