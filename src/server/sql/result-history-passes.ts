import type Database from "better-sqlite3";
import { statement } from "./statement.js";

const appliedStatement = statement(
  "SELECT 1 FROM result_history_passes WHERE name=?",
);
export function applied(db: Database.Database, name: string): boolean {
  return appliedStatement(db).get(name) !== undefined;
}

const recordStatement = statement(
  "INSERT INTO result_history_passes(name,applied_at) VALUES(?,?)",
);
export function record(db: Database.Database, name: string, at: number) {
  return recordStatement(db).run(name, at);
}
