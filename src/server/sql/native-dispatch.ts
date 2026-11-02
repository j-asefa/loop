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

const insertUnknownStatement = statement(
  "INSERT INTO native_dispatch VALUES(?,?,?,'unknown',NULL,?)",
);
export function insertUnknown(
  db: Database.Database,
  run: string,
  generation: string,
  digest: string,
  created: number,
) {
  return insertUnknownStatement(db).run(run, generation, digest, created);
}

const acceptUnknownStatement = statement(
  "UPDATE native_dispatch SET state='accepted' WHERE run_id=? AND state='unknown'",
);
export function acceptUnknown(db: Database.Database, run: string) {
  return acceptUnknownStatement(db).run(run);
}

const setErrorStatement = statement(
  "UPDATE native_dispatch SET error=? WHERE run_id=?",
);
export function setError(db: Database.Database, error: string, run: string) {
  return setErrorStatement(db).run(error, run);
}

const setStateStatement = statement(
  "UPDATE native_dispatch SET state=? WHERE run_id=?",
);
export function setState(db: Database.Database, state: string, run: string) {
  return setStateStatement(db).run(state, run);
}

const activeGenerationStatement = statement(
  "SELECT d.generation FROM native_dispatch d JOIN companion_sessions s ON s.conversation_id=? AND s.generation=d.generation AND s.state='running' WHERE d.run_id=? AND d.state IN ('unknown','accepted')",
);
const activeGenerationRow = QueryRecords.native_dispatch.pick({
  generation: true,
});
export function activeGeneration(
  db: Database.Database,
  conversation: string | null,
  run: string,
) {
  const row = activeGenerationStatement(db).get(conversation, run);
  return row === undefined
    ? undefined
    : parseRecord(activeGenerationRow, row, "native_dispatch");
}

const hasUnknownOrAcceptedStatement = statement(
  "SELECT 1 FROM native_dispatch WHERE run_id=? AND state IN ('unknown','accepted')",
);
const hasUnknownOrAcceptedRow = z.object({ "1": z.number() });
export function hasUnknownOrAccepted(
  db: Database.Database,
  run: string | null,
) {
  const row = hasUnknownOrAcceptedStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(hasUnknownOrAcceptedRow, row, "native_dispatch");
}

const existsForRunStatement = statement(
  "SELECT 1 FROM native_dispatch WHERE run_id=?",
);
const existsForRunRow = z.object({ "1": z.number() });
export function existsForRun(db: Database.Database, run: string) {
  const row = existsForRunStatement(db).get(run);
  return row === undefined
    ? undefined
    : parseRecord(existsForRunRow, row, "native_dispatch");
}
