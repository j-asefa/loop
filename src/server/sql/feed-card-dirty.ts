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
