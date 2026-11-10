import type Database from "better-sqlite3";

/** The callback must finish synchronously: other requests must not observe the
 * connection's temporary timeout, and ordinary writes retain their policy. */
export function withoutBusyWait<T>(db: Database.Database, run: () => T): T {
  const timeout = db.pragma("busy_timeout", { simple: true }) as number;
  try {
    db.pragma("busy_timeout = 0");
    return run();
  } finally {
    db.pragma(`busy_timeout = ${timeout}`);
  }
}
