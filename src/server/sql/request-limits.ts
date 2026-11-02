import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const incrementStatement = statement(
  "INSERT INTO request_limits VALUES(?,?,1) ON CONFLICT(owner_id) DO UPDATE SET window=excluded.window,count=CASE WHEN request_limits.window=excluded.window THEN request_limits.count+1 ELSE 1 END RETURNING count",
);
const incrementRow = z.object({ count: z.number() });
export function increment(
  db: Database.Database,
  owner: string,
  window: number,
) {
  const row = incrementStatement(db).get(owner, window);
  return row === undefined
    ? undefined
    : parseRecord(incrementRow, row, "request_limits");
}
