import type Database from "better-sqlite3";
import { statement } from "./statement.js";

const removeConnectionStatement = statement(
  "DELETE FROM grants WHERE connection_id=?",
);
export function removeConnection(db: Database.Database, connection: string) {
  return removeConnectionStatement(db).run(connection);
}
