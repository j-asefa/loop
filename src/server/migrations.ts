import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { historicalMigrationNames } from "./historical-migration-names.js";

const historicalNames = new Set(historicalMigrationNames.values());

// Tokenize comments and quoted identifiers too: whitespace, OR IGNORE and
// main."schema_version" must not hide an accidental legacy completion write.
function writesLedger(sql: string, names: ReadonlySet<string>) {
  const tokens = [
    ...sql.matchAll(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|[^\s]/gi,
    ),
  ]
    .filter(([raw]) => !raw.startsWith("--") && !raw.startsWith("/*"))
    .map(([raw]) => ({
      raw: raw.toLowerCase(),
      value: raw.replace(/^['"`\[]|['"`\]]$/g, "").toLowerCase(),
    }));
  return tokens.some((token, i) => {
    let table = i + 1;
    if (token.raw === "insert" || token.raw === "replace") {
      if (tokens[table]?.raw === "or") table += 2;
      if (tokens[table]?.raw !== "into") return false;
      table++;
    } else if (token.raw === "update") {
      if (tokens[table]?.raw === "or") table += 2;
    } else if (token.raw === "delete" && tokens[table]?.raw === "from") table++;
    else return false;
    if (tokens[table + 1]?.raw === ".") table += 2;
    return names.has(tokens[table]?.value);
  });
}

/** The same immediate migration boundary is used by API and worker startup. */
export function applyMigrations(
  db: Database.Database,
  directory: string | URL = new URL("../../migrations/", import.meta.url),
) {
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
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
      const ownedLedgers = new Set(["schema_migrations"]);
      if (!historicalNames.has(name)) ownedLedgers.add("schema_version");
      if (writesLedger(sql, ownedLedgers))
        throw new Error(
          `Migration ${file} writes a completion ledger (schema_version/schema_migrations); the runner records completion by name.`,
        );
      return { name, prefix: Number(prefix), sql };
    })
    .sort(
      (a, b) =>
        a.prefix - b.prefix || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );

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
  }).immediate();
}
