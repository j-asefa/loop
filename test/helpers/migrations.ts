import type Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../../src/server/migrations.js";

/**
 * Applies the repository migrations numbered up to and including `last`
 * through the production migrator, as a release that shipped them would have.
 */
export function applyMigrationsThrough(db: Database.Database, last: number) {
  const directory = mkdtempSync(join(tmpdir(), "loop-migrations-"));
  try {
    for (const file of readdirSync("migrations"))
      if (file.endsWith(".sql") && Number(file.split("-")[0]) <= last)
        copyFileSync(join("migrations", file), join(directory, file));
    applyMigrations(db, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
