import type Database from "better-sqlite3";

// Preparation must wait for migrations and projection-boundary installation.
// Callers supply their connection, including the explicit projection/fixture
// connection; never capture the application's db during module evaluation.
export function statement(sql: string) {
  const prepared = new WeakMap<Database.Database, Database.Statement>();
  return (db: Database.Database) => {
    let value = prepared.get(db);
    if (!value) {
      value = db.prepare(sql);
      prepared.set(db, value);
    }
    return value;
  };
}
