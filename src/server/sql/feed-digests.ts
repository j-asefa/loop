import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const forOwnerStatement = statement(
  "SELECT * FROM feed_digests WHERE owner_id=? ORDER BY created_at",
);

export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(QueryRecords.feed_digests, row, "feed_digests"));
}

const ownedStatement = statement(
  "SELECT * FROM feed_digests WHERE id=? AND owner_id=?",
);

export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.feed_digests, row, "feed_digests");
}

const updateStatement = statement(
  "UPDATE feed_digests SET agent_id=@agent,conversation_id=@conversation,feeds=@feeds,\n         minute_of_day=@minute,zone=@zone,unread_only=@unread,enabled=@enabled,last_error=NULL\n         WHERE id=@id AND owner_id=@owner",
);
export function update(
  db: Database.Database,
  row: {
    id: string;
    owner: string;
    agent: string;
    conversation: string | null;
    feeds: string | null;
    minute: number;
    zone: string;
    unread: number;
    enabled: number;
    at: number;
  },
) {
  return updateStatement(db).run(row);
}

const insertStatement = statement(
  "INSERT INTO feed_digests(id,owner_id,agent_id,conversation_id,feeds,minute_of_day,zone,unread_only,enabled,created_at)\n       VALUES(@id,@owner,@agent,@conversation,@feeds,@minute,@zone,@unread,@enabled,@at)",
);
export function insert(
  db: Database.Database,
  row: {
    id: string;
    owner: string;
    agent: string;
    conversation: string | null;
    feeds: string | null;
    minute: number;
    zone: string;
    unread: number;
    enabled: number;
    at: number;
  },
) {
  return insertStatement(db).run(row);
}

const removeStatement = statement(
  "DELETE FROM feed_digests WHERE id=? AND owner_id=?",
);
export function remove(db: Database.Database, id: string, owner: string) {
  return removeStatement(db).run(id, owner);
}

const enabledStatement = statement(
  "SELECT * FROM feed_digests WHERE enabled=1",
);

export function enabled(db: Database.Database) {
  return enabledStatement(db)
    .all()
    .map((row) => parseRecord(QueryRecords.feed_digests, row, "feed_digests"));
}

const deliveredStatement = statement(
  "UPDATE feed_digests SET last_run_at=?,last_error=NULL WHERE id=?",
);
export function delivered(db: Database.Database, time: number, id: string) {
  return deliveredStatement(db).run(time, id);
}

const failedStatement = statement(
  "UPDATE feed_digests SET last_run_at=?,last_error=?,enabled=? WHERE id=?",
);
export function failed(
  db: Database.Database,
  time: number,
  error: string,
  enabled: number,
  id: string,
) {
  return failedStatement(db).run(time, error, enabled, id);
}
