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
import { historicalMigrationNames } from "./fixtures/historical-migration-names.js";
import { applyMigrationsThrough } from "./helpers/migrations.js";

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
  // Seed the schema shipped in v0.1.0 before running current startup. Table
  // rebuilds must retain publication pointers and watch delivery/dedup history.
  const released = new Database(join(data, "loop.db"));
  released.pragma("foreign_keys = ON");
  applyMigrationsThrough(released, 154);
  released.exec(`
    INSERT INTO conversations(id,owner_id,title,created_at) VALUES('history','owner','Historical conversation',1);
    INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('run','owner','history','Historical question','completed','fixture',1,1);
    INSERT INTO artifacts(id,owner_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES('file','owner','history','run','Historical file','file','retained','{"uploaded":true}',1,1);
    INSERT INTO artifact_objects VALUES('file','owner','run','call','objects/abc/def','text/plain',8,'checksum');
    INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,created_at,updated_at) VALUES('watch','owner','history','agent','owner','repo',42,1,1);
    INSERT INTO pr_watch_seen VALUES('watch','comment',123);
    INSERT INTO pr_watch_deliveries VALUES('watch','run',1);
  `);
  const retainedTables = [
    "artifact_objects",
    "pr_watch_seen",
    "pr_watch_deliveries",
  ];
  const retained = Object.fromEntries(
    retainedTables.map((table) => [
      table,
      released.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  );
  const watch = released.prepare("SELECT * FROM pr_watches").get() as Record<
    string,
    unknown
  >;
  released.close();
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
      retained:Object.fromEntries(['artifact_objects','pr_watch_seen','pr_watch_deliveries'].map(table=>[table,db.prepare('SELECT * FROM '+table).all()])),
      watch:db.prepare('SELECT * FROM pr_watches').get(),
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
  expect(first.retained).toEqual(retained);
  expect(first.watch).toEqual(watch);
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
