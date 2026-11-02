import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const streamInitialStatement = statement(
  "UPDATE artifact_versions SET content=? WHERE artifact_id=? AND version=1",
);
export function streamInitial(
  db: Database.Database,
  content: string,
  artifact: string,
) {
  return streamInitialStatement(db).run(content, artifact);
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
