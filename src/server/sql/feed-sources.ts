import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const forOwnerStatement = statement(
  "SELECT * FROM feed_sources WHERE owner_id=? ORDER BY created_at, id",
);
const forOwnerRow = QueryRecords.feed_sources;
export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(forOwnerRow, row, "feed_sources"));
}

const ownedStatement = statement(
  "SELECT * FROM feed_sources WHERE owner_id=? AND id=?",
);
const ownedRow = QueryRecords.feed_sources;
export function owned(db: Database.Database, owner: string, id: string) {
  const row = ownedStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "feed_sources");
}

const countStatement = statement(
  "SELECT count(*) n FROM feed_sources WHERE owner_id=?",
);
const countRow = z.object({ n: z.number() });
export function count(db: Database.Database, owner: string) {
  const row = countStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(countRow, row, "feed_sources");
}

const insertStatement = statement(
  "INSERT INTO feed_sources(id,owner_id,url,title,home,category,kind,color,created_at)\n       VALUES(@id,@owner_id,@url,@title,@home,@category,@kind,@color,@created_at)",
);
export function insert(
  db: Database.Database,
  row: {
    id: string;
    owner_id: string;
    url: string;
    title: string;
    home: string;
    category: string;
    kind: string;
    color: string;
    created_at: number;
  },
) {
  return insertStatement(db).run(row);
}

const removeStatement = statement(
  "DELETE FROM feed_sources WHERE owner_id=? AND id=?",
);
export function remove(db: Database.Database, owner: string, id: string) {
  return removeStatement(db).run(owner, id);
}

const idsStatement = statement("SELECT id FROM feed_sources WHERE owner_id=?");
const idsRow = QueryRecords.feed_sources.pick({ id: true });
export function ids(db: Database.Database, owner: string) {
  return idsStatement(db)
    .all(owner)
    .map((row) => parseRecord(idsRow, row, "feed_sources"));
}

const insertIfAbsentStatement = statement(
  "INSERT INTO feed_sources(id,owner_id,url,title,home,category,kind,color,created_at)\n       VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,id) DO NOTHING",
);
export function insertIfAbsent(
  db: Database.Database,
  id: string,
  owner: string,
  url: string,
  title: string,
  home: string,
  category: string,
  kind: string,
  color: string,
  created: number,
) {
  return insertIfAbsentStatement(db).run(
    id,
    owner,
    url,
    title,
    home,
    category,
    kind,
    color,
    created,
  );
}

const markThroughStatement = statementVariants();
export function markThrough(
  db: Database.Database,
  at: number,
  owner: string,
  feed?: string,
) {
  return markThroughStatement(
    `UPDATE feed_sources SET read_through_at=?
     WHERE owner_id=?${feed ? " AND id=?" : ""}`,
    db,
  ).run(...[at, owner, ...(feed ? [feed] : [])]);
}
