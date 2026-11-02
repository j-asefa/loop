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
