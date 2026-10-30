import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { legacyMigrationNames } from "../src/server/legacy-migrations";

it("starts concurrent database clients and applies each migration once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop55-concurrent-start-"));
  try {
    const clients = Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              "--input-type=module",
              "-e",
              "const { db } = await import('./src/server/db.ts'); db.close();",
            ],
            {
              cwd: process.cwd(),
              env: { ...process.env, LOOP55_DATA_DIR: dir },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let stderr = "";
          child.stderr.on("data", (data) => (stderr += data));
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error(stderr)),
          );
        }),
    );
    const results = await Promise.allSettled(clients);
    for (const result of results)
      expect(result.status, JSON.stringify(result)).toBe("fulfilled");
    const database = new Database(join(dir, "loop55.db"));
    try {
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(
        database
          .prepare("SELECT name,prefix FROM schema_migrations ORDER BY name")
          .all(),
      ).toEqual(
        readdirSync(new URL("../migrations/", import.meta.url))
          .filter((file) => file.endsWith(".sql"))
          .map((file) => ({
            name: file.replace(/^\d+-|\.sql$/g, ""),
            prefix: Number(file.split("-")[0]),
          }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      );
      expect(
        database
          .prepare("SELECT version FROM schema_version ORDER BY version")
          .all(),
      ).toEqual(
        [...legacyMigrationNames.keys()]
          .sort((a, b) => a - b)
          .map((version) => ({ version })),
      );
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      database.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
