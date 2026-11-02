import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const connectionStatusStatement = statement(
  "INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at)\n        VALUES(?,NULL,'connection',?,'connection.status',?,?)",
);
export function connectionStatus(
  db: Database.Database,
  owner: string,
  id: string,
  payload: string,
  created: number,
) {
  return connectionStatusStatement(db).run(owner, id, payload, created);
}

const pageStatement = statement(
  "SELECT * FROM events WHERE owner_id=? AND id>? ORDER BY id LIMIT 200",
);
export function page(db: Database.Database, owner: string, after: number) {
  return pageStatement(db)
    .all(owner, after)
    .map((row) => parseRecord(QueryRecords.events, row, "events"));
}
export function* iteratePage(
  db: Database.Database,
  owner: string,
  after: number,
) {
  for (const row of pageStatement(db).iterate(owner, after))
    yield parseRecord(QueryRecords.events, row, "events");
}

const webhookEventStatement = statement(
  "SELECT id,owner_id,run_id,type,created_at FROM events WHERE id=?",
);
const webhookEventRow = QueryRecords.events.pick({
  id: true,
  owner_id: true,
  run_id: true,
  type: true,
  created_at: true,
});
export function webhookEvent(db: Database.Database, id: number | bigint) {
  const row = webhookEventStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(webhookEventRow, row, "events");
}
