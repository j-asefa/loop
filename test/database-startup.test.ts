import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDatabase } from "../src/server/database-startup.js";

it("importing the initializer does not create a database or data files", () => {
  const directory = mkdtempSync(join(tmpdir(), "loop-startup-import-"));
  try {
    const result = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `await import('./src/server/database-startup.ts');
       const {readdirSync}=await import('node:fs');
       console.log(JSON.stringify(readdirSync(process.env.LOOP_DATA_DIR)));`,
      ],
      { env: { ...process.env, LOOP_DATA_DIR: directory }, encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("initializes each connection once without replaying migrations or wrapping projection again", () => {
  const db = new Database(":memory:");
  try {
    startDatabase(db, () => {});
    const prepare = db.prepare,
      transaction = db.transaction;
    const records = db
      .prepare("SELECT * FROM schema_migrations ORDER BY name")
      .all();
    const changes = db.prepare("SELECT total_changes() n").get();
    expect(records.length).toBeGreaterThan(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.prepare("SELECT card_lower(?) value").get("E\u0301COLE")).toEqual(
      { value: "école" },
    );
    startDatabase(db, () => {
      throw new Error("Initialization must not run again");
    });
    expect(db.prepare).toBe(prepare);
    expect(db.transaction).toBe(transaction);
    expect(
      db.prepare("SELECT * FROM schema_migrations ORDER BY name").all(),
    ).toEqual(records);
    expect(db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  } finally {
    db.close();
  }
});
