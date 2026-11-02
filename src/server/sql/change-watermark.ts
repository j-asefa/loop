import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const clockStatement = statement(
  "SELECT epoch,last_event_id FROM change_watermark WHERE owner_id=?",
);
const clockRow = QueryRecords.change_watermark.pick({
  epoch: true,
  last_event_id: true,
});
export function clock(db: Database.Database, owner: string) {
  const row = clockStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(clockRow, row, "change_watermark");
}

const epochStatement = statement(
  "SELECT epoch FROM change_watermark WHERE owner_id=?",
);
const epochRow = QueryRecords.change_watermark.pick({ epoch: true });
export function epoch(db: Database.Database, owner: string) {
  const row = epochStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(epochRow, row, "change_watermark");
}
