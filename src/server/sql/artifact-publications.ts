import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT OR IGNORE INTO artifact_publications(artifact_id) VALUES(?)",
);
export function insert(db: Database.Database, artifact: string) {
  return insertStatement(db).run(artifact);
}
