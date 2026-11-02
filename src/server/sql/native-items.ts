import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertImportedStatement = statement(
  "INSERT OR IGNORE INTO native_items VALUES(?,?,NULL,?,?)",
);
export function insertImported(
  db: Database.Database,
  conversation: string,
  native: string,
  item: string,
  updated: number,
) {
  return insertImportedStatement(db).run(conversation, native, item, updated);
}

const upsertUnboundStatement = statement(
  "INSERT INTO native_items VALUES(?,?,NULL,?,?) ON CONFLICT(conversation_id,native_id) DO UPDATE SET item=excluded.item,updated_at=excluded.updated_at",
);
export function upsertUnbound(
  db: Database.Database,
  conversation: string,
  native: string,
  item: string,
  updated: number,
) {
  return upsertUnboundStatement(db).run(conversation, native, item, updated);
}

const runItemStatement = statement(
  "SELECT item FROM native_items WHERE conversation_id=? AND run_id=? AND native_id=?",
);
const runItemRow = QueryRecords.native_items.pick({ item: true });
export function runItem(
  db: Database.Database,
  conversation: string,
  run: string,
  native: string,
) {
  const row = runItemStatement(db).get(conversation, run, native);
  return row === undefined
    ? undefined
    : parseRecord(runItemRow, row, "native_items");
}

const assistantHistoryStatement =
  statement(`SELECT item FROM native_items WHERE conversation_id=? AND run_id=?
           AND json_extract(item,'$.kind')='assistant'
           AND json_extract(item,'$.phase') IS NOT 'commentary'
           ORDER BY rowid DESC`);
export function* assistantHistory(
  db: Database.Database,
  conversation: string,
  run: string,
) {
  for (const row of assistantHistoryStatement(db).iterate(conversation, run))
    yield parseRecord(
      QueryRecords.native_items.pick({ item: true }),
      row,
      "native_items",
    );
}
const upsertRunItemStatement = statement(
  "INSERT INTO native_items VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,native_id) DO UPDATE SET item=excluded.item,run_id=excluded.run_id,updated_at=excluded.updated_at",
);
export function upsertRunItem(
  db: Database.Database,
  conversation: string,
  native: string,
  run: string,
  item: string,
  updated: number,
) {
  return upsertRunItemStatement(db).run(
    conversation,
    native,
    run,
    item,
    updated,
  );
}
