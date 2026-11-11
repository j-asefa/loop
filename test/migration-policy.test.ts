import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { historicalMigrationNames } from "./fixtures/historical-migration-names.js";

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

it("checked-in migrations leave completion records to the runner", () => {
  const directory = new URL("../migrations/", import.meta.url);
  const files = readdirSync(directory).filter((file) => file.endsWith(".sql"));
  expect(files.length).toBeGreaterThan(0);
  const historical = new Set(historicalMigrationNames.values());
  for (const file of files) {
    const name = file.replace(/^\d+-|\.sql$/g, "");
    const ledgers = new Set(["schema_migrations"]);
    if (!historical.has(name)) ledgers.add("schema_version");
    expect(
      writesLedger(readFileSync(new URL(file, directory), "utf8"), ledgers),
      file,
    ).toBe(false);
  }
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
])("detects forbidden completion writes: %s", (sql) => {
  expect(
    writesLedger(sql, new Set(["schema_version", "schema_migrations"])),
  ).toBe(true);
});

it("ignores completion-ledger mentions in comments and string values", () => {
  expect(
    writesLedger(
      `
    -- INSERT INTO schema_version VALUES(122,0);
    /* INSERT OR IGNORE INTO schema_version VALUES(122,0); */
    CREATE TABLE notes(value TEXT);
    INSERT INTO notes VALUES('INSERT INTO schema_version VALUES(122,0)');
  `,
      new Set(["schema_version", "schema_migrations"]),
    ),
  ).toBe(false);
});
