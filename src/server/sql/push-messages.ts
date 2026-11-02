import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const enqueueOwnerStatement = statement(
  "INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at,category) SELECT id,?,?,?,?,?,? FROM push_subscriptions WHERE owner_id=?",
);
export function enqueueOwner(
  db: Database.Database,
  key: string,
  title: string,
  body: string,
  url: string,
  available: number,
  category: string,
  owner: string,
) {
  return enqueueOwnerStatement(db).run(
    key,
    title,
    body,
    url,
    available,
    category,
    owner,
  );
}

const claimStatement = statement(
  "UPDATE push_messages SET attempts=attempts+1,available_at=? WHERE subscription_id=? AND message_key=?",
);
export function claim(
  db: Database.Database,
  time: number,
  subscription: string,
  message: string | null,
) {
  return claimStatement(db).run(time, subscription, message);
}

const dueStatement = statement(
  "SELECT m.*,s.subscription,s.owner_id FROM push_messages m\n      JOIN push_subscriptions s ON s.id=m.subscription_id\n      WHERE m.delivered_at IS NULL AND m.available_at<=? AND m.attempts<? ORDER BY m.available_at LIMIT 4",
);
const dueRow = QueryRecords.push_messages.extend({
  subscription: z.string(),
  owner_id: z.string(),
});
export function due(db: Database.Database, time: number, maxAttempts: number) {
  return dueStatement(db)
    .all(time, maxAttempts)
    .map((row) => parseRecord(dueRow, row, "push_messages"));
}

const deliveredStatement = statement(
  "UPDATE push_messages SET delivered_at=? WHERE subscription_id=? AND message_key=?",
);
export function delivered(
  db: Database.Database,
  time: number,
  subscription: string,
  key: string | null,
) {
  return deliveredStatement(db).run(time, subscription, key);
}

const retryStatement = statement(
  "UPDATE push_messages SET available_at=? WHERE subscription_id=? AND message_key=?",
);
export function retry(
  db: Database.Database,
  time: number,
  subscription: string,
  key: string | null,
) {
  return retryStatement(db).run(time, subscription, key);
}

const pruneStatement = statement(
  "DELETE FROM push_messages WHERE delivered_at<? OR (attempts>=? AND available_at<?)",
);
export function prune(
  db: Database.Database,
  deliveredBefore: number,
  maxAttempts: number,
  availableBefore: number,
) {
  return pruneStatement(db).run(deliveredBefore, maxAttempts, availableBefore);
}
