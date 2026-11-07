import type Database from "better-sqlite3";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT OR IGNORE INTO done_card_reads(owner_id,conversation_id,card_key,read_at) VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  conversation: string,
  card: string,
  read: number,
) {
  return insertStatement(db).run(owner, conversation, card, read);
}

const removeStatement = statement(
  "DELETE FROM done_card_reads WHERE owner_id=? AND conversation_id=? AND card_key=?",
);
export function remove(
  db: Database.Database,
  owner: string,
  conversation: string,
  card: string,
) {
  return removeStatement(db).run(owner, conversation, card);
}
