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

const boundsStatement = statement(
  "SELECT\n      (SELECT id FROM events WHERE owner_id=@owner ORDER BY id LIMIT 1) first,\n      last_event_id last, epoch FROM change_watermark WHERE owner_id=@owner\n    ",
);
const boundsRow = z.object({
  first: z.number().nullable(),
  last: z.number(),
  epoch: z.string(),
});
export function bounds(db: Database.Database, owner: string) {
  const row = boundsStatement(db).get({ owner });
  return row === undefined
    ? undefined
    : parseRecord(boundsRow, row, "change_watermark");
}

const snapshotStatement = statement(
  `SELECT COALESCE(w.epoch,c.epoch) epoch,COALESCE(w.last_event_id,0) cursor
   FROM change_log_identity c LEFT JOIN change_watermark w ON w.owner_id=? WHERE c.singleton=1`,
);
const snapshotRow = epochRow.extend({
  cursor: QueryRecords.change_watermark.shape.last_event_id,
});
export function snapshot(db: Database.Database, owner: string) {
  return parseRecord(
    snapshotRow,
    snapshotStatement(db).get(owner),
    "change_watermark",
  );
}

const ensureOwnerStatement = statement(
  "INSERT OR IGNORE INTO change_watermark(owner_id,last_event_id,epoch) SELECT ?,0,epoch FROM change_log_identity WHERE singleton=1",
);
export function ensureOwner(db: Database.Database, owner: string): string {
  const existing = epoch(db, owner);
  if (existing) return existing.epoch;
  return db
    .transaction(() => {
      ensureOwnerStatement(db).run(owner);
      return epoch(db, owner)!.epoch;
    })
    .immediate();
}
