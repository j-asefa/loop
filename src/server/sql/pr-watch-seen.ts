import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const forWatchStatement = statement(
  "SELECT kind,item_id FROM pr_watch_seen WHERE watch_id=?",
);
const forWatchRow = QueryRecords.pr_watch_seen.pick({
  kind: true,
  item_id: true,
});
export function forWatch(db: Database.Database, watch: string) {
  return forWatchStatement(db)
    .all(watch)
    .map((row) => parseRecord(forWatchRow, row, "pr_watch_seen"));
}

const existsStatement = statement(
  "SELECT 1 FROM pr_watch_seen WHERE watch_id=? AND kind=? AND item_id=?",
);
export function exists(
  db: Database.Database,
  watch: string,
  kind: string,
  item: number,
) {
  const row = existsStatement(db).get(watch, kind, item);
  return row === undefined
    ? undefined
    : parseRecord(z.object({ "1": z.number() }), row, "pr_watch_seen");
}
const insertStatement = statement(
  "INSERT OR IGNORE INTO pr_watch_seen(watch_id,kind,item_id) VALUES(?,?,?)",
);
export function insert(
  db: Database.Database,
  watch: string,
  kind: string,
  item: number,
) {
  return insertStatement(db).run(watch, kind, item);
}
