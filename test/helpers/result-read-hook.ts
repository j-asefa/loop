import type Database from "better-sqlite3";

let afterRead: (() => void) | undefined;
export function armResultReadHook(callback?: () => void) {
  afterRead = callback;
}

// Install before production modules lazily cache statements. Each armed race
// observes execution of the revision read, including reuse of a cached query.
export function installResultReadHook(db: Database.Database) {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (
      sql.includes(
        "SELECT COALESCE(max(revision),0) revision FROM feed_revisions",
      )
    ) {
      const get = statement.get.bind(statement);
      statement.get = (...args: unknown[]) => {
        const row = get(...args);
        const callback = afterRead;
        afterRead = undefined;
        callback?.();
        return row;
      };
    }
    return statement;
  }) as typeof db.prepare;
}
