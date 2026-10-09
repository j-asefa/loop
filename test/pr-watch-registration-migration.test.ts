import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

it.each([false, true])(
  "upgrades an already recorded 066 with existing queue=%s",
  (existing) => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER); CREATE TABLE runs(id TEXT PRIMARY KEY); INSERT INTO runs VALUES('run'); INSERT INTO schema_version VALUES(66,0)",
      );
      const migration = readFileSync(
        "migrations/068-pr-watch-registrations.sql",
        "utf8",
      );
      if (existing) {
        db.exec(
          migration.replace(
            "INSERT INTO schema_version VALUES(68,unixepoch()*1000);",
            "",
          ),
        );
        db.exec(
          "INSERT INTO pr_watch_registrations VALUES('run','event','host',1,'owner','repo',42,3,123)",
        );
      }
      db.exec(migration);
      expect(
        db.prepare("SELECT version FROM schema_version ORDER BY version").all(),
      ).toEqual([{ version: 66 }, { version: 68 }]);
      if (existing)
        expect(
          db
            .prepare(
              "SELECT attempts,next_attempt_at FROM pr_watch_registrations",
            )
            .get(),
        ).toEqual({ attempts: 3, next_attempt_at: 123 });
      else
        expect(
          db.prepare("SELECT * FROM pr_watch_registrations").all(),
        ).toEqual([]);
    } finally {
      db.close();
    }
  },
);
