import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { historicalMigrationNames } from "../src/server/historical-migration-names.js";

const resources: (() => void)[] = [];
afterEach(() => {
  for (const dispose of resources.splice(0).reverse()) dispose();
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "loop-migration-identity-"));
  resources.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function database() {
  const db = new Database(":memory:");
  resources.push(() => db.close());
  return db;
}
function write(path: string, file: string, sql: string) {
  writeFileSync(join(path, file), sql);
}

it("applies equal prefixes in name order, then skips a renumbered identity", () => {
  const path = directory(),
    db = database();
  // Deliberately create in the opposite order. A name, not a directory entry or
  // numeric prefix, determines whether a migration has already completed.
  write(path, "122-beta.sql", "INSERT INTO history VALUES('beta');");
  write(
    path,
    "122-alpha.sql",
    "CREATE TABLE history(value TEXT); INSERT INTO history VALUES('alpha');",
  );
  applyMigrations(db, path);
  expect(db.prepare("SELECT value FROM history ORDER BY rowid").all()).toEqual([
    { value: "alpha" },
    { value: "beta" },
  ]);
  const before = db
    .prepare("SELECT * FROM schema_migrations ORDER BY name")
    .all();
  renameSync(join(path, "122-alpha.sql"), join(path, "130-alpha.sql"));
  write(path, "123-gamma.sql", "INSERT INTO history VALUES('gamma');");
  applyMigrations(db, path);
  expect(
    db
      .prepare(
        "SELECT * FROM schema_migrations WHERE name IN ('alpha','beta') ORDER BY name",
      )
      .all(),
  ).toEqual(before);
  expect(db.prepare("SELECT value FROM history ORDER BY rowid").all()).toEqual([
    { value: "alpha" },
    { value: "beta" },
    { value: "gamma" },
  ]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('schema_version','schema_migration_state')",
      )
      .all(),
  ).toEqual([]);
});

it("refuses duplicate names before changing the database", () => {
  const path = directory(),
    db = database();
  write(path, "122-shared.sql", "CREATE TABLE should_not_exist(id INTEGER);");
  write(path, "123-shared.sql", "CREATE TABLE also_not_applied(id INTEGER);");
  expect(() => applyMigrations(db, path)).toThrow(
    "Duplicate migration name: shared",
  );
  expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
});

it.each([
  "INSERT INTO schema_version VALUES(122,0)",
  'InSeRt /* comment */ OR IGNORE INTO main."schema_version" VALUES(122,0)',
  "REPLACE INTO [schema_version] VALUES(122,0)",
  "INSERT INTO 'schema_version' VALUES(122,0)",
  "UPDATE `schema_version` SET applied_at=0",
  "DELETE FROM schema_version",
  "INSERT INTO schema_migrations VALUES('future',122,0)",
  "CREATE TRIGGER bad AFTER INSERT ON history BEGIN INSERT INTO schema_version VALUES(122,0); END",
])("rejects a new migration that writes the retired ledger: %s", (sql) => {
  const path = directory(),
    db = database();
  write(path, "122-future.sql", sql + ";");
  expect(() => applyMigrations(db, path)).toThrow(/writes a completion ledger/);
  expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
});

it("ignores legacy table mentions in SQL comments and string values", () => {
  const path = directory(),
    db = database();
  write(
    path,
    "122-example.sql",
    `
    -- INSERT INTO schema_version VALUES(122,0);
    /* INSERT OR IGNORE INTO schema_version VALUES(122,0); */
    CREATE TABLE notes(value TEXT);
    INSERT INTO notes VALUES('INSERT INTO schema_version VALUES(122,0)');
  `,
  );
  applyMigrations(db, path);
  expect(db.prepare("SELECT count(*) n FROM notes").get()).toEqual({ n: 1 });
});

it("rolls back SQL and completion records together, then retries safely", () => {
  const path = directory(),
    db = database();
  write(
    path,
    "122-interrupted.sql",
    "CREATE TABLE half_applied(id INTEGER); INSERT INTO missing_table VALUES(1);",
  );
  expect(() => applyMigrations(db, path)).toThrow(/no such table/);
  expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  write(
    path,
    "122-interrupted.sql",
    "CREATE TABLE half_applied(id INTEGER); INSERT INTO half_applied VALUES(1);",
  );
  applyMigrations(db, path);
  applyMigrations(db, path);
  expect(db.prepare("SELECT count(*) n FROM half_applied").get()).toEqual({
    n: 1,
  });
  expect(db.prepare("SELECT name,prefix FROM schema_migrations").all()).toEqual(
    [{ name: "interrupted", prefix: 122 }],
  );
});

it("refuses an earlier numbered ledger without changing its records", () => {
  const db = database(),
    path = directory();
  db.exec(
    "CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL); INSERT INTO schema_version VALUES(1,0)",
  );
  expect(() => applyMigrations(db, path)).toThrow(/fresh LOOP_DATA_DIR/);
  expect(db.prepare("SELECT * FROM schema_version").all()).toEqual([
    { version: 1, applied_at: 0 },
  ]);
  expect(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'")
      .get(),
  ).toBeUndefined();
});

it("records historical completion by name at real startup and restarts without migration writes", () => {
  const data = directory();
  const start = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
    const {db}=await import('./src/server/db.ts');
    console.log(JSON.stringify({
      applied:db.prepare('SELECT * FROM schema_migrations ORDER BY name').all(),
      legacy:db.prepare('SELECT * FROM schema_version ORDER BY version').all(),
      integrity:db.pragma('integrity_check'),foreignKeys:db.pragma('foreign_key_check')
    }));db.close();
  `,
        ],
        {
          env: {
            ...process.env,
            LOOP_DATA_DIR: data,
          },
          encoding: "utf8",
        },
      ),
    );
  const first = start();
  expect(first.applied.map((row: { name: string }) => row.name)).toEqual(
    readdirSync("migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/^\d+-|\.sql$/g, ""))
      .sort(),
  );
  expect(first.legacy.map((row: { version: number }) => row.version)).toEqual(
    [...historicalMigrationNames.keys()].sort((a, b) => a - b),
  );
  expect(first.applied).toEqual(
    expect.arrayContaining(
      [104, 105, 106].map((prefix) =>
        expect.objectContaining({
          prefix,
          name: historicalMigrationNames.get(prefix),
        }),
      ),
    ),
  );
  expect(first.integrity).toEqual([{ integrity_check: "ok" }]);
  expect(first.foreignKeys).toEqual([]);
  expect(start()).toEqual(first);
}, 15000);
