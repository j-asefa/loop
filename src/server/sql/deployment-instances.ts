import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const freshStatement = statement(
  "SELECT * FROM deployment_instances WHERE stopped_at IS NULL AND seen_at>=? ORDER BY id",
);
const freshRow = QueryRecords.deployment_instances;
export function fresh(db: Database.Database, since: number) {
  return freshStatement(db)
    .all(since)
    .map((row) => parseRecord(freshRow, row, "deployment_instances"));
}

const pruneStatement = statement(
  "DELETE FROM deployment_instances WHERE seen_at<?",
);
export function prune(db: Database.Database, before: number) {
  return pruneStatement(db).run(before);
}

const insertStatement = statement(
  "INSERT INTO deployment_instances VALUES(?,?,?,?,?,NULL)",
);
export function insert(
  db: Database.Database,
  id: string,
  role: string,
  build: string,
  started: number,
  seen: number,
) {
  return insertStatement(db).run(id, role, build, started, seen);
}

const heartbeatStatement = statement(
  "UPDATE deployment_instances SET seen_at=?,build=? WHERE id=? AND stopped_at IS NULL",
);
export function heartbeat(
  db: Database.Database,
  time: number,
  build: string,
  id: string,
) {
  return heartbeatStatement(db).run(time, build, id);
}

const stopStatement = statement(
  "UPDATE deployment_instances SET stopped_at=? WHERE id=?",
);
export function stop(db: Database.Database, time: number, id: string) {
  return stopStatement(db).run(time, id);
}
