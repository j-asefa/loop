import type Database from "better-sqlite3";
import { statement } from "./statement.js";

const upsertStatement = statement(
  "INSERT INTO push_preferences(subscription_id,needs_you,completed,reminders,social) VALUES(?,?,?,?,?)\n        ON CONFLICT(subscription_id) DO UPDATE SET needs_you=excluded.needs_you,completed=excluded.completed,reminders=excluded.reminders,social=excluded.social",
);
export function upsert(
  db: Database.Database,
  subscription: string,
  needsYou: number,
  completed: number,
  reminders: number,
  social: number,
) {
  return upsertStatement(db).run(
    subscription,
    needsYou,
    completed,
    reminders,
    social,
  );
}
