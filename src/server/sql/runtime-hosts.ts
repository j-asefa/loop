import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT * FROM runtime_hosts WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.runtime_hosts, row, "runtime_hosts");
}

const publicListStatement = statement(
  "SELECT id,name,url,kind FROM runtime_hosts WHERE owner_id=? ORDER BY created_at",
);
const publicListRow = QueryRecords.runtime_hosts.pick({
  id: true,
  name: true,
  url: true,
  kind: true,
});
export function publicList(db: Database.Database, owner: string) {
  return publicListStatement(db)
    .all(owner)
    .map((row) => parseRecord(publicListRow, row, "runtime_hosts"));
}

const insertStatement = statement(
  "INSERT INTO runtime_hosts(id,owner_id,name,url,secret,created_at,kind) VALUES(?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  url: string,
  secret: string,
  created: number,
  kind: string,
) {
  return insertStatement(db).run(id, owner, name, url, secret, created, kind);
}

const removeStatement = statement(
  "DELETE FROM runtime_hosts WHERE id=? AND owner_id=?",
);
export function remove(db: Database.Database, id: string, owner: string) {
  return removeStatement(db).run(id, owner);
}
