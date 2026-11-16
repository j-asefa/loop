// Scaffolds a per-table query module in the shape of the SQL recipe's
// canonical example (src/server/sql/mcp-preferences.ts) and refreshes the SQL
// index. Usage: npm run new:sql-module -- <table_name>
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sqlIndex } from "./sql-index.mjs";

const recipe = "docs/architecture.md#recipe-add-or-extend-a-sql-table-module";

/** Module text for `table`; imports match the canonical example's. */
export function sqlModuleTemplate(table) {
  return `import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Queries for the ${table} table (${recipe}).
// TODO: add ${table} to QueryRecords in sql/rows.ts and create it in a migration.

const ownedStatement = statement("SELECT * FROM ${table} WHERE owner_id=?");

/** Rows of ${table} owned by \`owner\`. */
export function owned(db: Database.Database, owner: string) {
  return ownedStatement(db)
    .all(owner)
    .map((row) => parseRecord(QueryRecords.${table}, row, "${table}"));
}
`;
}

/** Writes src/server/sql/<table>.ts under `root` and regenerates the index. */
export function generateSqlModule(root, table) {
  if (!/^[a-z][a-z0-9_]*$/.test(table))
    throw new Error(
      `Table name "${table}" must be lowercase letters, digits and underscores`,
    );
  const directory = join(root, "src/server/sql");
  const module = table.replaceAll("_", "-") + ".ts";
  const path = join(directory, module);
  if (existsSync(path))
    throw new Error(
      `src/server/sql/${module} already exists; extend it instead (${recipe})`,
    );
  writeFileSync(path, sqlModuleTemplate(table));
  writeFileSync(join(root, "docs/sql-index.md"), sqlIndex(directory).text);
  return `src/server/sql/${module}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const table = process.argv[2];
  if (!table || process.argv.length > 3) {
    console.error("Usage: npm run new:sql-module -- <table_name>");
    process.exit(1);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    const created = generateSqlModule(root, table);
    console.log(`Created ${created} and refreshed docs/sql-index.md. Next:
1. Create the ${table} table in a new migration under migrations/.
2. Add ${table} to QueryRecords in src/server/sql/rows.ts; test/row-schema-columns.test.ts compares them.
3. Replace the placeholder query, keeping statement() and owner filtering.
4. Call the module from its production caller and test it there (${recipe}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
