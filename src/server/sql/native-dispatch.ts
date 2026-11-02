import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const activeConversationGenerationStatement = statement(
  "SELECT d.generation FROM native_dispatch d\n        JOIN companion_sessions s ON s.conversation_id=? AND s.generation=d.generation AND s.state='running'\n        WHERE d.run_id=? AND d.state IN ('unknown','accepted')",
);
const activeConversationGenerationRow = QueryRecords.native_dispatch.pick({
  generation: true,
});
export function activeConversationGeneration(
  db: Database.Database,
  conversation: string | null,
  run: string,
) {
  const row = activeConversationGenerationStatement(db).get(conversation, run);
  return row === undefined
    ? undefined
    : parseRecord(activeConversationGenerationRow, row, "native_dispatch");
}

const generationStateStatement = statement(
  "SELECT generation,state FROM native_dispatch WHERE run_id=?",
);
const generationStateRow = QueryRecords.native_dispatch.pick({
  generation: true,
  state: true,
});
export function generationState(db: Database.Database, run: string) {
  const row = generationStateStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(generationStateRow, row, "native_dispatch");
}

const existsStatement = statement(
  "SELECT 1 FROM native_dispatch WHERE run_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, run: string) {
  const row = existsStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "native_dispatch");
}

const hasAcceptedOrUnknownStatement = statement(
  "SELECT 1 FROM native_dispatch WHERE run_id=? AND state IN ('accepted','unknown')",
);
const hasAcceptedOrUnknownRow = z.object({ "1": z.number() });
export function hasAcceptedOrUnknown(db: Database.Database, run: string) {
  const row = hasAcceptedOrUnknownStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(hasAcceptedOrUnknownRow, row, "native_dispatch");
}
