import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const runningGenerationStatement = statement(
  "SELECT 1 FROM companion_sessions WHERE conversation_id=? AND generation=? AND state='running'",
);
const runningGenerationRow = z.object({ "1": z.number() });
export function runningGeneration(
  db: Database.Database,
  conversation: string | null,
  generation: string | null,
) {
  const row = runningGenerationStatement(db).get(conversation, generation);
  return row === undefined
    ? undefined
    : parseRecord(runningGenerationRow, row, "companion_sessions");
}
