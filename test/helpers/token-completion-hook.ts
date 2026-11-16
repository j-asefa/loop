import type Database from "better-sqlite3";

let failNext = false;
export function failNextTokenCompletion() {
  failNext = true;
}

// A connection-local trigger faults the stored transition, including cached
// statements. The JS flag stays consumed when SQLite rolls the write back.
export function installTokenCompletionHook(db: Database.Database) {
  db.function("fixture_token_completion", () => {
    if (failNext) {
      failNext = false;
      throw new Error("Fixture crash before receipt completion");
    }
    return null;
  });
  db.exec(`CREATE TEMP TRIGGER fixture_token_completion
    BEFORE UPDATE OF state ON main.token_requests
    WHEN NEW.state='complete'
    BEGIN SELECT fixture_token_completion(); END`);
}
