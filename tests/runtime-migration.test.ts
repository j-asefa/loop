import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

for (const branch of ["main", "hapi"] as const)
  it(`migrates the ${branch} session schema without losing its history`, () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-schema-"));
    try {
      const db = new Database(join(dir, "loop.db"));
      db.exec(
        "CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
      );
      const migrations = readdirSync("migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of migrations) {
        const number = Number(file.split("-")[0]);
        if (branch === "main" && number > 22) continue;
        if (branch === "hapi" && number >= 19 && number < 27) continue;
        let sql = readFileSync(join("migrations", file), "utf8");
        if (branch === "main")
          sql = sql.replaceAll("companion_sessions", "native_sessions");
        else
          sql = sql
            .replace("VALUES(27,", "VALUES(20,")
            .replace("VALUES(28,", "VALUES(21,");
        db.exec(sql);
      }
      if (branch === "main")
        db.prepare("INSERT INTO deployment_profile VALUES(1,'server')").run();
      db.exec(
        "CREATE TABLE preserved_history(content TEXT); INSERT INTO preserved_history VALUES('keep me')",
      );
      db.close();
      const result = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `const {db}=await import('./src/server/db.ts'); console.log(JSON.stringify({history:db.prepare('SELECT content FROM preserved_history').get(),hapi:db.pragma('table_info(native_sessions)').map(c=>c.name),companion:db.pragma('table_info(companion_sessions)').map(c=>c.name)}));db.close();`,
        ],
        {
          cwd: resolve("."),
          env: { ...process.env, LOOP_PROFILE: "server", LOOP_DATA_DIR: dir },
          encoding: "utf8",
        },
      );
      const migrated = JSON.parse(result);
      expect(migrated.history.content).toBe("keep me");
      expect(migrated.hapi).toContain("hub_session_id");
      expect(migrated.companion).toContain("harness");
      expect(migrated.companion).toContain("effort");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
