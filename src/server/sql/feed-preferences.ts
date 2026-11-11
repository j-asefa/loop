import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT * FROM feed_preferences WHERE owner_id=?",
);

export function owned(db: Database.Database, owner: string) {
  const row = ownedStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.feed_preferences, row, "feed_preferences");
}

const upsertStatement = statement(
  "INSERT INTO feed_preferences(owner_id,agent_access,images,updated_at) VALUES(?,?,?,?)\n     ON CONFLICT(owner_id) DO UPDATE SET agent_access=excluded.agent_access,\n       images=excluded.images, updated_at=excluded.updated_at",
);
export function upsert(
  db: Database.Database,
  owner: string,
  access: number,
  images: number,
  at: number,
) {
  return upsertStatement(db).run(owner, access, images, at);
}
