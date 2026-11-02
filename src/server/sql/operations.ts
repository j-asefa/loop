import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT * FROM operations WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.operations, row, "operations");
}

const insertMoveStatement = statement(
  "INSERT INTO operations VALUES(?,?,?,?,?,0,?)",
);
export function insertMove(
  db: Database.Database,
  id: string,
  owner: string,
  artifact: string,
  previous: string,
  version: number,
  created: number,
) {
  return insertMoveStatement(db).run(
    id,
    owner,
    artifact,
    previous,
    version,
    created,
  );
}

const markUndoneStatement = statement(
  "UPDATE operations SET undone=1 WHERE id=?",
);
export function markUndone(db: Database.Database, id: string) {
  return markUndoneStatement(db).run(id);
}
