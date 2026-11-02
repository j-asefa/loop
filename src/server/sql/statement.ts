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

// Query modules build variants from placeholder arity and fixed predicates,
// never bound values. Each variant still prepares lazily per connection.
export function statementVariants() {
  const variants = new Map<string, ReturnType<typeof statement>>();
  return (sql: string, db: Database.Database) => {
    let variant = variants.get(sql);
    if (!variant) {
      variant = statement(sql);
      variants.set(sql, variant);
    }
    return variant(db);
  };
}
