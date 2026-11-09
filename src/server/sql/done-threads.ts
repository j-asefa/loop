import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT id,title,created_at FROM done_threads WHERE owner_id=? AND id=?",
);
const ownedRow = QueryRecords.done_threads.pick({
  id: true,
  title: true,
  created_at: true,
});
export function owned(db: Database.Database, owner: string, id: string) {
  const row = ownedStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "done_threads");
}

const pageStatement = statement(
  "SELECT id,title,created_at FROM done_threads WHERE owner_id=@owner AND (@before IS NULL OR created_at<@before OR (created_at=@before AND id>@id)) ORDER BY created_at DESC,id LIMIT @limit",
);
const pageRow = QueryRecords.done_threads.pick({
  id: true,
  title: true,
  created_at: true,
});
export function page(
  db: Database.Database,
  owner: string,
  before: number | null,
  id: string,
  limit: number,
) {
  return pageStatement(db)
    .all({ owner, before, id, limit })
    .map((row) => parseRecord(pageRow, row, "done_threads"));
}

const pruneStatement = statement(
  "DELETE FROM done_threads WHERE owner_id=? AND (SELECT count(*) FROM done_thread_members m WHERE m.owner_id=done_threads.owner_id AND m.thread_id=done_threads.id)<2",
);
export function prune(db: Database.Database, owner: string) {
  return pruneStatement(db).run(owner);
}

const insertStatement = statement(
  "INSERT INTO done_threads(id,owner_id,title,created_at) VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  title: string,
  created: number,
) {
  return insertStatement(db).run(id, owner, title, created);
}

const removeStatement = statement(
  "DELETE FROM done_threads WHERE owner_id=? AND id=?",
);
export function remove(db: Database.Database, owner: string, id: string) {
  return removeStatement(db).run(owner, id);
}

const forOwnerStatement = statement(
  "SELECT id,title,created_at FROM done_threads WHERE owner_id=? ORDER BY created_at DESC,id",
);
export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(ownedRow, row, "done_threads"));
}
