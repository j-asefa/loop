import type Database from "better-sqlite3";
import { z } from "zod";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
const anyStatement = statement("SELECT 1 FROM feed_card_dirty LIMIT 1");
const anyRow = z.object({ "1": z.number() });
export function any(db: Database.Database) {
  const row = anyStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(anyRow, row, "feed_card_dirty");
}

// Every conversation with a published output or a projected result card is
// re-projected in full, so cards follow the Results they display.
const markResultConversationsDirtyStatement = statement(
  `INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key)
   SELECT owner_id,conversation_id,'*' FROM results
   WHERE sealed=1 AND kind IN ('run_answer','imported_answer')
   UNION
   SELECT owner_id,conversation_id,'*' FROM feed_cards WHERE kind='result'`,
);
export function markResultConversationsDirty(db: Database.Database) {
  return markResultConversationsDirtyStatement(db).run();
}
