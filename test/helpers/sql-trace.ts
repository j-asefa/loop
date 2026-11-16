import type SqliteDatabase from "better-sqlite3";

/** Observe actual executions through SQLite's public logger, including cached statements. */
export function traceDatabase(
  Database: typeof SqliteDatabase,
  observe: (sql: string) => void,
) {
  return new Proxy(Database, {
    construct(Constructor, [filename, options]) {
      return new Constructor(filename, {
        ...options,
        verbose(sql: string) {
          options?.verbose?.(sql);
          observe(sql);
        },
      });
    },
  });
}
