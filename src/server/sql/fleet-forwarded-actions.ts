import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const getStatement = statement(
  "SELECT * FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
);
const getRow = QueryRecords.fleet_forwarded_actions;
export function get(db: Database.Database, owner: string, command: string) {
  const row = getStatement(db).get(owner, command);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_forwarded_actions");
}

const insertStatement = statement(
  "INSERT INTO fleet_forwarded_actions VALUES(?,?,?,?,?,?,?,'unknown',NULL,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  command: string,
  peer: string,
  fleet: string,
  grant: string,
  route: string,
  digest: string,
  created: number,
  updated: number,
) {
  return insertStatement(db).run(
    owner,
    command,
    peer,
    fleet,
    grant,
    route,
    digest,
    created,
    updated,
  );
}

const finishStatement = statement(
  "UPDATE fleet_forwarded_actions SET state=?,result=?,updated_at=? WHERE owner_id=? AND command_id=? AND state IN ('unknown','started')",
);
export function finish(
  db: Database.Database,
  state: string,
  result: string | null,
  updated: number,
  owner: string,
  command: string,
) {
  return finishStatement(db).run(state, result, updated, owner, command);
}

const pruneResultsStatement = statement(
  "UPDATE fleet_forwarded_actions SET result=NULL WHERE owner_id=? AND result IS NOT NULL AND rowid NOT IN\n        (SELECT rowid FROM fleet_forwarded_actions WHERE owner_id=? AND result IS NOT NULL ORDER BY updated_at DESC,rowid DESC LIMIT 64)",
);
export function pruneResults(
  db: Database.Database,
  owner: string,
  retainedOwner: string,
) {
  return pruneResultsStatement(db).run(owner, retainedOwner);
}
