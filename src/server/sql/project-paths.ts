import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement("INSERT INTO project_paths VALUES(?,?)");
export function insert(db: Database.Database, folder: string, path: string) {
  return insertStatement(db).run(folder, path);
}
