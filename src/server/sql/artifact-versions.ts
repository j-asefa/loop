import type Database from "better-sqlite3";
import { statement } from "./statement.js";

const updateInitialContentStatement = statement(
  "UPDATE artifact_versions SET content=? WHERE artifact_id=? AND version=1",
);
export function updateInitialContent(
  db: Database.Database,
  content: string,
  artifact: string,
) {
  return updateInitialContentStatement(db).run(content, artifact);
}

const insertStatement = statement(
  "INSERT INTO artifact_versions VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  artifact: string,
  version: number,
  content: string,
  created: number,
) {
  return insertStatement(db).run(id, artifact, version, content, created);
}
