import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const heartbeatStatement = statement(
  "INSERT OR REPLACE INTO worker_health VALUES(?,?)",
);
export function heartbeat(db: Database.Database, id: string, time: number) {
  return heartbeatStatement(db).run(id, time);
}

const removeStatement = statement("DELETE FROM worker_health WHERE id=?");
export function remove(db: Database.Database, id: string) {
  return removeStatement(db).run(id);
}

const latestStatement = statement(
  "SELECT max(heartbeat) last FROM worker_health",
);
const latestRow = z.object({ last: z.number().nullable() });
export function latest(db: Database.Database) {
  const row = latestStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(latestRow, row, "worker_health");
}

const previewHeartbeatStatement = statement(
  "INSERT OR REPLACE INTO worker_health VALUES('design-preview',?)",
);
export function previewHeartbeat(db: Database.Database, at: number) {
  return previewHeartbeatStatement(db).run(at);
}

const removePreviewStatement = statement(
  "DELETE FROM worker_health WHERE id='design-preview'",
);
export function removePreview(db: Database.Database) {
  return removePreviewStatement(db).run();
}
