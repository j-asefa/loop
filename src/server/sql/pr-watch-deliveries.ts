import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const removeWatchStatement = statement(
  "DELETE FROM pr_watch_deliveries WHERE watch_id=?",
);
export function removeWatch(db: Database.Database, watch: string) {
  return removeWatchStatement(db).run(watch);
}

const activeRunStatement = statement(
  "SELECT 1 FROM pr_watch_deliveries d JOIN runs r ON r.id=d.run_id WHERE d.watch_id=? AND r.state IN ('queued','running','pausing','paused','awaiting_approval')",
);
const activeRunRow = z.object({ "1": z.number() });
export function activeRun(db: Database.Database, watch: string) {
  const row = activeRunStatement(db).get(watch);
  return row === undefined
    ? undefined
    : parseRecord(activeRunRow, row, "pr_watch_deliveries");
}

const recentCountStatement = statement(
  "SELECT count(*) n FROM pr_watch_deliveries WHERE watch_id=? AND created_at>?",
);
const recentCountRow = z.object({ n: z.number() });
export function recentCount(
  db: Database.Database,
  watch: string,
  since: number,
) {
  const row = recentCountStatement(db).get(watch, since);
  return row === undefined
    ? undefined
    : parseRecord(recentCountRow, row, "pr_watch_deliveries");
}

const insertStatement = statement(
  "INSERT INTO pr_watch_deliveries(watch_id,run_id,created_at) VALUES(?,?,?)",
);
export function insert(
  db: Database.Database,
  watch: string,
  run: string,
  created: number,
) {
  return insertStatement(db).run(watch, run, created);
}
