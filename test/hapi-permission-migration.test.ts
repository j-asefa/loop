import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.each(["main", "hapi-preview", "both"])(
  "preserves both migrations after upgrading %s's version 68",
  (branch) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-hapi-lease-migration-"));
    try {
      const db = new Database(join(dir, "loop.db"));
      db.exec(
        "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      for (const file of readdirSync("migrations")
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        const version = Number(file.split("-")[0]);
        if (version > (branch === "main" ? 66 : 67)) continue;
        db.exec(readFileSync(join("migrations", file), "utf8"));
      }
      if (branch !== "hapi-preview")
        db.exec(
          readFileSync("migrations/068-pr-watch-registrations.sql", "utf8"),
        );
      if (branch !== "main") {
        db.exec(
          readFileSync(
            "migrations/069-native-permission-delivery-lease.sql",
            "utf8",
          ),
        );
        db.exec(
          "DELETE FROM schema_version WHERE version=69; INSERT OR IGNORE INTO schema_version VALUES(68,0)",
        );
      }
      db.close();
      const result = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        const {db}=await import('./src/server/db.ts');
        console.log(JSON.stringify({
          registrations:!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='pr_watch_registrations'").get(),
          lease:db.pragma('table_info(native_permissions)').filter(c=>c.name==='delivery_expires_at').length,
          versions:db.prepare('SELECT version FROM schema_version WHERE version>=67 ORDER BY version').all().map(x=>x.version)
        }));
        db.close();
      `,
        ],
        {
          env: { ...process.env, LOOP_PROFILE: "server", LOOP_DATA_DIR: dir },
          encoding: "utf8",
        },
      );
      expect(JSON.parse(result)).toEqual({
        registrations: true,
        lease: 1,
        versions: [67, 68, 69],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
