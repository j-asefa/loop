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

const boundedReplayStatement = statement(
  "SELECT id,run_id,subject_kind,subject_id,type,\n              CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload END payload\n             FROM events WHERE owner_id=? AND id>? ORDER BY id LIMIT 100",
);
const boundedReplayRow = QueryRecords.events
  .pick({
    id: true,
    run_id: true,
    subject_kind: true,
    subject_id: true,
    type: true,
  })
  .extend({ payload: z.string().nullable() });
export function boundedReplay(
  db: Database.Database,
  maxBytes: number,
  owner: string,
  after: number,
) {
  return boundedReplayStatement(db)
    .all(maxBytes, owner, after)
    .map((row) => parseRecord(boundedReplayRow, row, "events"));
}

const previewQueuedStatement = statement(
  "SELECT 1 FROM events WHERE owner_id=? AND run_id=? AND type='queued' LIMIT 1",
);
const previewQueuedRow = z.object({ "1": z.number() });
export function previewQueued(
  db: Database.Database,
  owner: string,
  run: string,
) {
  const row = previewQueuedStatement(db).get(owner, run);
  return row === undefined
    ? undefined
    : parseRecord(previewQueuedRow, row, "events");
}
