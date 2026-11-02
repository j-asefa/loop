import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const hasResultStatement = statement(
  "SELECT 1 FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind='result' AND card_key=?",
);
const hasResultRow = z.object({ "1": z.number() });
export function hasResult(
  db: Database.Database,
  owner: string,
  conversation: string,
  card: string,
) {
  const row = hasResultStatement(db).get(owner, conversation, card);
  return row === undefined
    ? undefined
    : parseRecord(hasResultRow, row, "feed_cards");
}
