import type Database from "better-sqlite3";
import { applyMigrations } from "./migrations.js";
import { projectFeed } from "./feed-projector.js";
import { installProjectionBoundary } from "./projected-database.js";
import { installLocalEffectAuthority } from "./effect-authority.js";
import { refuseRecordedEffects } from "./recorded-effects.js";

const initialized = new WeakSet<Database.Database>();

export function startDatabase(
  db: Database.Database,
  emit: Parameters<typeof projectFeed>[1],
) {
  if (initialized.has(db)) return;
  // SQLite lower() is ASCII-only; search fields and queries need the same Unicode normalization.
  db.function("card_lower", { deterministic: true }, (value) =>
    typeof value === "string" ? value.normalize("NFC").toLowerCase() : null,
  );
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
  // A migration that rewrites stored history holds this lock for longer than a
  // statement timeout. The API and worker start together, so the process that
  // does not win the migration waits for it instead of failing to start.
  db.pragma("busy_timeout = 120000");
  // Mutating transactions must use .immediate(): API and worker processes share
  // this WAL database. A deferred read snapshot cannot safely upgrade after
  // another process commits, even with busy_timeout configured.
  db.transaction(() => {
    applyMigrations(db);
    projectFeed(db, emit);
  }).immediate();
  installProjectionBoundary(db, () => projectFeed(db, emit));
  installLocalEffectAuthority(refuseRecordedEffects(db));
  db.pragma("busy_timeout = 5000");
  initialized.add(db);
}
