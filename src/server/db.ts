import { capabilities } from "./profile.js";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
export const db: Database.Database = new Database(join(config.data, "loop.db"));
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
db.transaction(() => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
  );
  // Check before migrations create the profile table: old schemas are unsupported.
  db.transaction(() => {
    const existing = db.prepare("SELECT 1 FROM schema_version LIMIT 1").get();
    const profiled = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='deployment_profile'",
      )
      .get();
    if (existing && !profiled)
      throw new Error(
        "Pre-unification databases are unsupported. Choose a fresh LOOP_DATA_DIR.",
      );
  }).immediate();
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
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO deployment_profile VALUES(1,?)").run(
      capabilities.profile,
    );
    const stored = db
      .prepare("SELECT profile FROM deployment_profile WHERE singleton=1")
      .get() as { profile: string };
    if (stored.profile !== capabilities.profile)
      throw new Error(
        `This data directory belongs to the ${stored.profile} profile. Choose a separate LOOP_DATA_DIR for ${capabilities.profile}.`,
      );
  }).immediate();
}).immediate();
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
