import type Database from "better-sqlite3";
import { z } from "zod";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const claimStatement = statement(
  "UPDATE push_deliveries SET attempts=attempts+1,available_at=? WHERE subscription_id=? AND artifact_id=?",
);
export function claim(
  db: Database.Database,
  time: number,
  subscription: string,
  artifact: string | null,
) {
  return claimStatement(db).run(time, subscription, artifact);
}

const dueStatement = statement(
  "SELECT d.subscription_id,d.artifact_id,d.attempts,s.subscription,s.owner_id,a.title,a.kind,substr(a.content,1,4000) content,c.title thread,g.name,a.conversation_id,json_extract(a.metadata,'$.messageId') message_id FROM push_deliveries d\n      JOIN push_subscriptions s ON s.id=d.subscription_id\n      JOIN artifacts a ON a.id=d.artifact_id LEFT JOIN agents g ON g.id=a.agent_id\n      LEFT JOIN conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id\n      WHERE d.delivered_at IS NULL AND d.available_at<=? AND d.attempts<? ORDER BY d.available_at LIMIT 4",
);
const dueRow = z.object({
  subscription_id: z.string(),
  artifact_id: z.string(),
  attempts: z.number(),
  subscription: z.string(),
  owner_id: z.string(),
  title: z.string(),
  kind: z.string(),
  content: z.string(),
  thread: z.string().nullable(),
  name: z.string().nullable(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
});
export function due(db: Database.Database, time: number, maxAttempts: number) {
  return dueStatement(db)
    .all(time, maxAttempts)
    .map((row) => parseRecord(dueRow, row, "push_deliveries"));
}

const deliveredStatement = statement(
  "UPDATE push_deliveries SET delivered_at=? WHERE subscription_id=? AND artifact_id=?",
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
  "UPDATE push_deliveries SET available_at=? WHERE subscription_id=? AND artifact_id=?",
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
  "DELETE FROM push_deliveries WHERE delivered_at<? OR (attempts>=? AND available_at<?)",
);
export function prune(
  db: Database.Database,
  deliveredBefore: number,
  maxAttempts: number,
  availableBefore: number,
) {
  return pruneStatement(db).run(deliveredBefore, maxAttempts, availableBefore);
}
