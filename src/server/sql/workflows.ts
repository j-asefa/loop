import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT * FROM workflows WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.workflows, row, "workflows");
}

const forOwnerStatement = statement(
  "SELECT * FROM workflows WHERE owner_id=? ORDER BY created_at DESC",
);
const forOwnerRow = QueryRecords.workflows;
export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(forOwnerRow, row, "workflows"));
}

const saveStatement = statement(
  "UPDATE workflows SET title=?,version=?,source=?,compiled=? WHERE id=?",
);
export function save(
  db: Database.Database,
  title: string,
  version: number,
  source: string,
  compiled: string,
  id: string,
) {
  return saveStatement(db).run(title, version, source, compiled, id);
}

const insertStatement = statement(
  "INSERT INTO workflows VALUES(?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  title: string,
  version: number,
  source: string,
  compiled: string,
  created: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    title,
    version,
    source,
    compiled,
    created,
  );
}
