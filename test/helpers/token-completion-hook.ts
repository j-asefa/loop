import type Database from "better-sqlite3";

let failNext = false;
export function failNextTokenCompletion() {
  failNext = true;
}

// Install before the production query cache is populated. Fault injection
// targets one execution, whether its statement is new or already cached.
export function installTokenCompletionHook(db: Database.Database) {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("UPDATE token_requests SET state='complete'")) {
      const run = statement.run.bind(statement);
      statement.run = (...args: unknown[]) => {
        if (failNext) {
          failNext = false;
          throw new Error("Fixture crash before receipt completion");
        }
        return run(...args);
      };
    }
    return statement;
  }) as typeof db.prepare;
}
