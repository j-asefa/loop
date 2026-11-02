import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const chargeStatement = statement(
  "INSERT INTO card_owner_limits VALUES(?,?,1) ON CONFLICT(owner_id) DO UPDATE SET window=excluded.window,count=CASE WHEN card_owner_limits.window=excluded.window THEN card_owner_limits.count+1 ELSE 1 END RETURNING count n",
);
const chargeRow = z.object({ n: z.number() });
export function charge(
  db: Database.Database,
  owner: string | undefined,
  window: number,
) {
  const row = chargeStatement(db).get(owner, window);
  return row === undefined
    ? undefined
    : parseRecord(chargeRow, row, "card_owner_limits");
}
