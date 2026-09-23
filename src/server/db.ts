import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
export const db = new Database(join(config.data, "loop.db"));
db.pragma("busy_timeout = 5000");
// Simultaneous API/worker startup can hit SQLITE_BUSY while switching a fresh
// database to WAL, before SQLite can use its normal busy handler.
const walDeadline = performance.now() + 5000;
const walWait = new Int32Array(new SharedArrayBuffer(4));
for (;;) {
  try {
    db.pragma("journal_mode = WAL");
    break;
  } catch (error) {
    if (
      (error as { code?: string }).code !== "SQLITE_BUSY" ||
      performance.now() >= walDeadline
    )
      throw error;
    Atomics.wait(walWait, 0, 0, 50);
  }
}
db.pragma("foreign_keys = ON");
// Mutating transactions must use .immediate(): API and worker processes share
// this WAL database. A deferred read snapshot cannot safely upgrade after
// another process commits, even with busy_timeout configured.
db.exec(
  "CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
);
for (const migration of readdirSync(
  new URL("../../migrations/", import.meta.url),
)
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  db.transaction(() => {
    if (
      !db
        .prepare("SELECT 1 FROM schema_version WHERE version=?")
        .get(Number(migration.split("-")[0]))
    )
      db.exec(
        readFileSync(
          new URL("../../migrations/" + migration, import.meta.url),
          "utf8",
        ),
      );
  }).immediate();
}
export const now = () => Date.now();
export const id = () => crypto.randomUUID();
export function emit(
  owner: string,
  run: string,
  type: string,
  payload: unknown,
) {
  return db
    .prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,?,?,?)",
    )
    .run(owner, run, type, JSON.stringify(payload), now()).lastInsertRowid;
}
