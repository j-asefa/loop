import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const forOwnerStatement = statement(
  "SELECT * FROM feed_watches WHERE owner_id=? ORDER BY created_at",
);

export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(QueryRecords.feed_watches, row, "feed_watches"));
}

const updateStatement = statement(
  "UPDATE feed_watches SET query=?,feeds=CASE WHEN ? THEN ? ELSE feeds END,enabled=? WHERE id=? AND owner_id=?",
);
export function update(
  db: Database.Database,
  query: string,
  changeFeeds: number,
  feeds: string | null,
  enabled: number,
  id: string,
  owner: string,
) {
  return updateStatement(db).run(query, changeFeeds, feeds, enabled, id, owner);
}

const insertStatement = statement(
  "INSERT INTO feed_watches(id,owner_id,query,feeds,created_at,since_at,enabled)\n       VALUES(@id,@owner,@query,@feeds,@created,@created,@enabled)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  query: string,
  feeds: string | null,
  created: number,
  enabled: number,
) {
  return insertStatement(db).run({ id, owner, query, feeds, created, enabled });
}

const ownedStatement = statement(
  "SELECT * FROM feed_watches WHERE id=? AND owner_id=?",
);

export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.feed_watches, row, "feed_watches");
}

const removeStatement = statement(
  "DELETE FROM feed_watches WHERE id=? AND owner_id=?",
);
export function remove(db: Database.Database, id: string, owner: string) {
  return removeStatement(db).run(id, owner);
}

const enabledStatement = statement(
  "SELECT * FROM feed_watches WHERE enabled=1",
);

export function enabled(db: Database.Database) {
  return enabledStatement(db)
    .all()
    .map((row) => parseRecord(QueryRecords.feed_watches, row, "feed_watches"));
}

const matchedStatement = statement(
  "UPDATE feed_watches SET matches=matches+1,last_match_at=? WHERE id=?",
);
export function matched(db: Database.Database, time: number, id: string) {
  return matchedStatement(db).run(time, id);
}
