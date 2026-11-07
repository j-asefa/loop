import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

it("applies agent mail and feed archive migrations in either upgrade order", () => {
  const migrations = readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const names = migrations.map((name) => name.replace(/^\d+-|\.sql$/g, ""));
  expect(new Set(names).size).toBe(names.length);

  const feedArchive = readFileSync(
    "migrations/047-conversation-feed-hidden.sql",
    "utf8",
  );
  const agentMail = readFileSync("migrations/048-agent-mail.sql", "utf8");
  for (const order of [
    [feedArchive, agentMail], // fresh install or #67 first
    [agentMail, feedArchive], // #64 first, then #67
  ]) {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
      );
      for (const file of migrations) {
        if (Number(file.split("-")[0]) >= 47) continue;
        db.exec(readFileSync(join("migrations", file), "utf8"));
      }
      for (const sql of order) db.exec(sql);
      expect(
        db
          .prepare(
            "SELECT version FROM schema_version WHERE version IN (47,48) ORDER BY version",
          )
          .all(),
      ).toEqual([{ version: 47 }, { version: 48 }]);
      expect(db.pragma("table_info(conversations)")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "feed_hidden" }),
        ]),
      );
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='agent_mail'")
          .get(),
      ).toEqual({ name: "agent_mail" });
      expect(db.pragma("table_info(delegations)")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "background" }),
        ]),
      );
    } finally {
      db.close();
    }
  }
});
