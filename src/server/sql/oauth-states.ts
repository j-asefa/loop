import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const validStatement = statement(
  "SELECT 1 FROM oauth_states WHERE state=? AND owner_id=? AND expires_at>?",
);
const validRow = z.object({ "1": z.number() });
export function valid(
  db: Database.Database,
  state: unknown,
  owner: string,
  time: number,
) {
  const row = validStatement(db).get(state, owner, time);
  return row === undefined
    ? undefined
    : parseRecord(validRow, row, "oauth_states");
}
