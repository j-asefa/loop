import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeResultContentDigestFromRawJson,
  registerResultSqliteFunctions,
} from "./result-digest.js";
const DEFAULT_MIGRATIONS_URL = new URL("../../migrations/", import.meta.url);
const DEFAULT_MIGRATIONS_PATH = fileURLToPath(DEFAULT_MIGRATIONS_URL);
let cachedDefaultMigrations:
  { name: string; prefix: number; sql: string }[] | null = null;

function loadMigrations(path: string) {
  if (path === DEFAULT_MIGRATIONS_PATH && cachedDefaultMigrations) {
    return cachedDefaultMigrations;
  }
  const names = new Set<string>();
  const migrations = readdirSync(path)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/.exec(file);
      if (
        !match ||
        !Number.isSafeInteger(Number(match[1])) ||
        Number(match[1]) < 1
      )
        throw new Error(`Invalid migration filename: ${file}`);
      const [, prefix, name] = match;
      if (names.has(name)) throw new Error(`Duplicate migration name: ${name}`);
      names.add(name);
      const sql = readFileSync(join(path, file), "utf8");
      return { name, prefix: Number(prefix), sql };
    })
    .sort(
      (a, b) =>
        a.prefix - b.prefix || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  if (path === DEFAULT_MIGRATIONS_PATH) {
    cachedDefaultMigrations = migrations;
  }
  return migrations;
}

/** The same immediate migration boundary is used by API and worker startup. */
export function applyMigrations(
  db: Database.Database,
  directory: string | URL = DEFAULT_MIGRATIONS_URL,
) {
  registerResultSqliteFunctions(db);
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
  const migrations = loadMigrations(path);

  db.transaction(() => {
    const table = (name: string) =>
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    if (
      !table("schema_migrations") &&
      table("schema_version") &&
      db.prepare("SELECT 1 FROM schema_version LIMIT 1").get()
    )
      throw new Error(
        "Earlier Loop database layouts are unsupported. Start with a fresh LOOP_DATA_DIR.",
      );
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(
      name TEXT PRIMARY KEY, prefix INTEGER NOT NULL, applied_at INTEGER NOT NULL
    )`);
    const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE name=?");
    const record = db.prepare(
      "INSERT INTO schema_migrations(name,prefix,applied_at) VALUES(?,?,?)",
    );
    for (const migration of migrations) {
      if (applied.get(migration.name)) continue;
      db.exec(migration.sql);
      record.run(migration.name, migration.prefix, Date.now());
    }
    if (table("results")) {
      const pendingDigests = db
        .prepare(
          "SELECT owner_id, id, kind, stimulus, outcome, attachments, provenance, lineage FROM results WHERE content_digest='0000000000000000000000000000000000000000000000000000000000000000'",
        )
        .all() as {
        owner_id: string;
        id: string;
        kind: string;
        stimulus: string;
        outcome: string;
        attachments: string;
        provenance: string;
        lineage: string;
      }[];
      if (pendingDigests.length > 0) {
        const updateDigest = db.prepare(
          "UPDATE results SET content_digest=? WHERE owner_id=? AND id=?",
        );
        for (const r of pendingDigests) {
          const digest = computeResultContentDigestFromRawJson(
            r.id,
            r.kind,
            r.stimulus,
            r.outcome,
            r.attachments,
            r.provenance,
            r.lineage,
          );
          updateDigest.run(digest, r.owner_id, r.id);
        }
      }
    }
  }).immediate();
}
