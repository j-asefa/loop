import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT * FROM agent_definitions WHERE id=? AND owner_id=?",
);
const ownedRow = QueryRecords.agent_definitions;
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "agent_definitions");
}

const getStatement = statement("SELECT * FROM agent_definitions WHERE id=?");
const getRow = QueryRecords.agent_definitions;
export function get(db: Database.Database, id: string) {
  const row = getStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "agent_definitions");
}

const updateStatement = statement(
  "UPDATE agent_definitions SET kind=?,name=?,description=?,markdown=?,version=version+1,updated_at=? WHERE id=? AND owner_id=?",
);
export function update(
  db: Database.Database,
  kind: string,
  name: string,
  description: string,
  markdown: string,
  updated: number,
  id: string,
  owner: string,
) {
  return updateStatement(db).run(
    kind,
    name,
    description,
    markdown,
    updated,
    id,
    owner,
  );
}

const insertStatement = statement(
  "INSERT INTO agent_definitions(id,owner_id,kind,name,description,markdown,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  kind: string,
  name: string,
  description: string,
  markdown: string,
  created: number,
  updated: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    kind,
    name,
    description,
    markdown,
    created,
    updated,
  );
}

const summariesStatement = statement(
  "SELECT id,kind,name,description,version,created_at,updated_at FROM agent_definitions WHERE owner_id=? ORDER BY updated_at DESC,id",
);
const summariesRow = QueryRecords.agent_definitions.omit({
  owner_id: true,
  markdown: true,
});
export function summaries(db: Database.Database, owner: string) {
  return summariesStatement(db)
    .all(owner)
    .map((row) => parseRecord(summariesRow, row, "agent_definitions"));
}

const removeStatement = statement(
  "DELETE FROM agent_definitions WHERE id=? AND owner_id=?",
);
export function remove(db: Database.Database, id: string, owner: string) {
  return removeStatement(db).run(id, owner);
}
