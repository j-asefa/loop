import type Database from "better-sqlite3";
import { statement } from "./statement.js";

const saveStatement = statement(
  "INSERT INTO saved_labels(owner_id,item_key,label,updated_at) VALUES(?,?,?,?)\n          ON CONFLICT(owner_id,item_key) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at",
);
export function save(
  db: Database.Database,
  owner: string,
  item: string,
  label: string,
  updated: number,
) {
  return saveStatement(db).run(owner, item, label, updated);
}

const removeStatement = statement(
  "DELETE FROM saved_labels WHERE owner_id=? AND item_key=?",
);
export function remove(db: Database.Database, owner: string, item: string) {
  return removeStatement(db).run(owner, item);
}
