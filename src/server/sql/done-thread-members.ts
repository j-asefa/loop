import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const resultsStatement = statement(
  "SELECT m.card_id,m.conversation_id,p.card_key FROM done_thread_members m\n        JOIN feed_cards p ON p.owner_id=m.owner_id AND p.conversation_id=m.conversation_id\n          AND p.kind='result' AND p.card_key=substr(m.card_id,3)\n        WHERE m.owner_id=? AND m.thread_id=?",
);
const resultsRow = QueryRecords.done_thread_members
  .pick({ card_id: true, conversation_id: true })
  .extend({ card_key: z.string() });
export function results(db: Database.Database, owner: string, thread: string) {
  return resultsStatement(db)
    .all(owner, thread)
    .map((row) => parseRecord(resultsRow, row, "done_thread_members"));
}

const removeStatement = statement(
  "DELETE FROM done_thread_members WHERE owner_id=? AND thread_id=? AND card_id=?",
);
export function remove(
  db: Database.Database,
  owner: string,
  thread: string,
  card: string,
) {
  return removeStatement(db).run(owner, thread, card);
}

const cardsStatement = statement(
  "SELECT card_id FROM done_thread_members WHERE owner_id=? AND thread_id=? ORDER BY card_id",
);
const cardsRow = QueryRecords.done_thread_members.pick({ card_id: true });
export function cards(db: Database.Database, owner: string, thread: string) {
  return cardsStatement(db)
    .all(owner, thread)
    .map((row) => parseRecord(cardsRow, row, "done_thread_members"));
}
const moveStatement =
  statement(`INSERT INTO done_thread_members(owner_id,card_id,thread_id,conversation_id) VALUES(?,?,?,?)
    ON CONFLICT(owner_id,card_id) DO UPDATE SET thread_id=excluded.thread_id,conversation_id=excluded.conversation_id`);
export function move(
  db: Database.Database,
  owner: string,
  card: string,
  thread: string,
  conversation: string | null,
) {
  return moveStatement(db).run(owner, card, thread, conversation);
}
