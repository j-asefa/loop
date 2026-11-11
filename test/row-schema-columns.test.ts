import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/server/migrations.js";
import { QueryRecords } from "../src/server/sql/rows.js";

it("table record keys match every declared table in a freshly migrated database", () => {
  const db = new Database(":memory:");
  try {
    applyMigrations(db);
    const columns = db.prepare("SELECT name FROM pragma_table_info(?)");
    for (const [table, schema] of Object.entries(QueryRecords)) {
      const names = columns
        .all(table)
        .map((column) => (column as { name: string }).name);
      expect(names.length, table).toBeGreaterThan(0);
      expect(Object.keys(schema.shape).sort(), table).toEqual(names.sort());
    }
  } finally {
    db.close();
  }
});
