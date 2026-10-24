import type Database from "better-sqlite3";

/** Keep derived rows and the source event log in the same SQLite commit.
 *
 * Every production workspace writer uses this connection. Standalone writes
 * become immediate transactions; explicit transactions drain once, after the
 * outer callback. Nested savepoint rollback also rolls back its dirty marks.
 * This is a synchronous commit boundary, never a change-bus subscriber.
 */
export function installProjectionBoundary(
  db: Database.Database,
  project: () => void,
) {
  const prepare = db.prepare.bind(db);
  const transaction = db.transaction.bind(db);
  const exec = db.exec.bind(db);
  let depth = 0;
  let writes = 0;
  let projecting = false;

  function drain() {
    if (projecting) return;
    projecting = true;
    try {
      project();
    } finally {
      projecting = false;
    }
  }
  db.transaction = ((fn: (...args: unknown[]) => unknown) =>
    transaction(function (this: unknown, ...args: unknown[]) {
      const outer = depth++ === 0;
      const before = writes;
      try {
        const result = fn.apply(this, args);
        if (result && typeof (result as Promise<unknown>).then === "function")
          throw new TypeError("Transaction function cannot return a promise");
        if (outer && writes !== before) drain();
        return result;
      } finally {
        depth--;
      }
    })) as typeof db.transaction;

  function write<T>(operation: () => T): T {
    if (db.inTransaction) {
      if (!depth && !projecting)
        throw new Error("Workspace writes require db.transaction()");
      writes++;
      return operation();
    }
    return db
      .transaction(() => {
        writes++;
        return operation();
      })
      .immediate();
  }
  db.prepare = ((sql: string) => {
    const command = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim();
    if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(command))
      throw new Error("Use db.transaction() for workspace transaction control");
    const statement = prepare(sql);
    if (!statement.readonly) {
      for (const method of ["run", "get", "all"] as const) {
        const original = statement[method].bind(statement);
        Object.defineProperty(statement, method, {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => write(() => original(...args)),
        });
      }
      // Lazy RETURNING would keep the write open beyond its producer boundary.
      statement.iterate = () => {
        throw new Error("Use all() for a workspace write with RETURNING");
      };
    }
    return statement;
  }) as typeof db.prepare;
  db.exec = (sql: string) => {
    // Native transaction control must not commit around the boundary. Trigger
    // bodies have BEGIN/END syntax but cannot contain transaction statements.
    const tokens = sql.replace(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
      " ",
    );
    if (
      /(?:^|;)\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(tokens) ||
      (!/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(tokens) &&
        /(?:^|;)\s*END\b/i.test(tokens))
    )
      throw new Error("Use db.transaction() for workspace transaction control");
    return write(() => exec(sql));
  };
}
