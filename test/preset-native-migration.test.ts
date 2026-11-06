import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.each(["main", "native-preview", "fresh"])(
  "preserves presets and recovery when upgrading %s's migration 70",
  (branch) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-preset-native-migration-"));
    try {
      const db = new Database(join(dir, "loop.db"));
      db.exec(
        "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      for (const file of readdirSync("migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        if (Number(file.split("-")[0]) <= 69)
          db.exec(readFileSync(join("migrations", file), "utf8"));
      }
      if (branch === "main")
        db.exec(readFileSync("migrations/070-team-presets.sql", "utf8"));
      if (branch === "native-preview")
        db.exec(
          readFileSync(
            "migrations/071-restore-native-harnesses.sql",
            "utf8",
          ).replace("VALUES(71,", "VALUES(70,"),
        );
      // A preview account may have deliberately disconnected after recovery;
      // renumbering that migration must not reconnect it or request sign-in.
      db.prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES('native','owner','codex','Native','','disconnected',?,0)",
      ).run(
        JSON.stringify({ loopHarness: "codex", retiredDirectRuntime: true }),
      );
      db.close();
      for (let restart = 0; restart < 2; restart++) {
        const result = execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
          const {db} = await import('./src/server/db.ts');
          console.log(JSON.stringify({
            versions: db.prepare('SELECT prefix AS version FROM schema_migrations WHERE prefix >= 70 ORDER BY prefix').all().map(r => r.version),
            presets: !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='team_creations'").get(),
            reviews: !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='code_reviews'").get(),
            status: db.prepare("SELECT status FROM connections WHERE id='native'").get().status,
          }));
          db.close();
        `,
          ],
          {
            env: {
              ...process.env,
              LOOP_DATA_DIR: dir,
            },
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        expect(JSON.parse(result)).toEqual({
          versions: readdirSync("migrations")
            .filter((name) => name.endsWith(".sql"))
            .map((name) => Number(name.split("-")[0]))
            .filter((version) => version >= 70)
            .sort((a, b) => a - b),
          presets: true,
          reviews: true,
          status:
            branch === "native-preview" ? "disconnected" : "needs_sign_in",
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
