import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { legacyMigrationNames } from "../src/server/legacy-migrations.js";

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
  // New migrations never put their completion in the compatibility ledger.
  expect(db.prepare("SELECT * FROM schema_version").all()).toEqual([]);
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
  "INSERT INTO schema_migration_state VALUES(1,0)",
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

it("rolls back translation, branch repair and SQL together, then retries safely", () => {
  const path = directory(),
    db = database();
  // Reconstruct the 51 permission preview: the translator must free 51 for
  // Social while preserving the permission migration under its frozen name.
  db.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
    INSERT INTO schema_version VALUES(51,123);
    CREATE TABLE deployment_profile(singleton INTEGER PRIMARY KEY,profile TEXT);
    CREATE TABLE mcp_preferences(agent_permission_mode TEXT);
    CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('keep');`);
  write(
    path,
    "122-interrupted.sql",
    "CREATE TABLE half_applied(id INTEGER); INSERT INTO missing_table VALUES(1);",
  );
  expect(() => applyMigrations(db, path)).toThrow(/no such table/);
  expect(db.prepare("SELECT * FROM schema_version").all()).toEqual([
    { version: 51, applied_at: 123 },
  ]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('schema_migrations','schema_migration_state','half_applied')",
      )
      .all(),
  ).toEqual([]);
  write(
    path,
    "122-interrupted.sql",
    "CREATE TABLE half_applied(id INTEGER); INSERT INTO half_applied VALUES(1);",
  );
  applyMigrations(db, path);
  expect(
    db
      .prepare(
        "SELECT name,prefix,applied_at FROM schema_migrations WHERE name='agent-permission-preference'",
      )
      .get(),
  ).toEqual({
    name: "agent-permission-preference",
    prefix: 52,
    applied_at: 123,
  });
  expect(db.prepare("SELECT value FROM preserved").get()).toEqual({
    value: "keep",
  });
  expect(db.prepare("SELECT count(*) n FROM half_applied").get()).toEqual({
    n: 1,
  });
  applyMigrations(db, path);
  expect(db.prepare("SELECT count(*) n FROM half_applied").get()).toEqual({
    n: 1,
  });
});

it("uses the frozen legacy map when a historical file changes prefix", () => {
  const path = directory(),
    db = database();
  db.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
    INSERT INTO schema_version VALUES(104,456);
    CREATE TABLE deployment_profile(singleton INTEGER PRIMARY KEY,profile TEXT);`);
  // If current filenames supplied translation identity, 104 would be lost or
  // incorrectly become a new unrelated migration that reused that prefix.
  write(path, "130-done-cards.sql", "SELECT * FROM must_not_run;");
  write(path, "104-another.sql", "CREATE TABLE new_feature(id INTEGER);");
  applyMigrations(db, path);
  expect(
    db
      .prepare(
        "SELECT name,prefix,applied_at FROM schema_migrations WHERE name='done-cards'",
      )
      .get(),
  ).toEqual({ name: "done-cards", prefix: 104, applied_at: 456 });
  expect(
    db.prepare("SELECT name FROM schema_migrations ORDER BY name").all(),
  ).toEqual([{ name: "another" }, { name: "done-cards" }]);
});

it("does not consult the legacy ledger after the translation marker commits", () => {
  const path = directory(),
    db = database();
  write(path, "122-feature.sql", "CREATE TABLE feature(id INTEGER);");
  applyMigrations(db, path);
  // An unknown legacy row would reject translation, but cannot alter a named
  // database's applied set or make a completed migration execute again.
  db.exec("INSERT INTO schema_version VALUES(999999,0)");
  applyMigrations(db, path);
  expect(db.prepare("SELECT name FROM schema_migrations").all()).toEqual([
    { name: "feature" },
  ]);
});

it("refuses an unknown legacy identity without recording a partial translation", () => {
  const db = database(),
    path = directory();
  db.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
    INSERT INTO schema_version VALUES(999999,0);
    CREATE TABLE deployment_profile(singleton INTEGER PRIMARY KEY,profile TEXT);`);
  expect(() => applyMigrations(db, path)).toThrow(
    "Unknown legacy migration 999999",
  );
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='schema_migration_state'",
      )
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
      state:db.prepare('SELECT * FROM schema_migration_state').all(),
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
    [...legacyMigrationNames.keys()].sort((a, b) => a - b),
  );
  expect(first.applied).toEqual(
    expect.arrayContaining(
      [104, 105, 106].map((prefix) =>
        expect.objectContaining({
          prefix,
          name: legacyMigrationNames.get(prefix),
        }),
      ),
    ),
  );
  expect(first.integrity).toEqual([{ integrity_check: "ok" }]);
  expect(first.foreignKeys).toEqual([]);
  expect(start()).toEqual(first);
}, 15000);

it.each([93, 94])(
  "recognizes historical brief migration %i without its completion record",
  (cutoff) => {
    const path = directory(),
      db = database();
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql") && Number(f.split("-")[0]) <= cutoff)
      .sort()) {
      db.exec(readFileSync(join("migrations", file), "utf8"));
    }
    db.exec(`DELETE FROM schema_version WHERE version=${cutoff}`);
    // A nonexistent source would fail if translation lost the recognized name.
    write(
      path,
      `${cutoff}-${legacyMigrationNames.get(cutoff)}.sql`,
      "SELECT * FROM must_not_run;",
    );
    applyMigrations(db, path);
    expect(
      db
        .prepare("SELECT prefix FROM schema_migrations WHERE name=?")
        .get(legacyMigrationNames.get(cutoff)),
    ).toEqual({ prefix: cutoff });
  },
);
