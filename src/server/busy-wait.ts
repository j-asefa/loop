import type Database from "better-sqlite3";

/** The callback must finish synchronously: other requests must not observe the
 * connection's temporary timeout, and ordinary writes retain their policy. */
function withoutBusyWait<T>(db: Database.Database, run: () => T): T {
  const timeout = db.pragma("busy_timeout", { simple: true }) as number;
  try {
    db.pragma("busy_timeout = 0");
    return run();
  } finally {
    db.pragma(`busy_timeout = ${timeout}`);
  }
}

const delayed = new WeakMap<Database.Database, Set<string>>();

/**
 * Only local, repeatable writes belong here; contention never replays work.
 * Timer writes (liveness heartbeats in worker.ts and deployments.ts, periodic
 * native display flushes in native/projector.ts) skip a tick while another
 * process holds the write lock and try again on the next, so contention cannot
 * fail their callbacks; a skipped heartbeat leaves its timestamp unchanged, so
 * stale observations still expire. Device renewal and retirement defer to a
 * later request or heartbeat.
 */
export function tryWithoutBusyWait(
  db: Database.Database,
  label: string,
  write: () => unknown,
): boolean {
  return withoutBusyWait(db, () => {
    try {
      write();
      delayed.get(db)?.delete(label);
      return true;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "SQLITE_BUSY" && !code?.startsWith("SQLITE_BUSY_"))
        throw error;
      let labels = delayed.get(db);
      if (!labels) delayed.set(db, (labels = new Set()));
      if (!labels.has(label)) {
        labels.add(label);
        console.warn(
          JSON.stringify({ diagnostic: "write-delayed", write: label, code }),
        );
      }
      return false;
    }
  });
}
