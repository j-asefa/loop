import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const prepareStatement = statement(
  "INSERT INTO fleet_handoffs VALUES(?,?,?,'prepared',NULL)",
);
export function prepare(
  db: Database.Database,
  owner: string,
  digest: string,
  proposal: string,
) {
  return prepareStatement(db).run(owner, digest, proposal);
}

const insertCommittedStatement = statement(
  "INSERT INTO fleet_handoffs VALUES(?,?,?,'committed',?)",
);
export function insertCommitted(
  db: Database.Database,
  owner: string,
  digest: string,
  proposal: string,
  result: string,
) {
  return insertCommittedStatement(db).run(owner, digest, proposal, result);
}

const preparedStatement = statement(
  "SELECT digest FROM fleet_handoffs WHERE owner_id=? AND digest=? AND state='prepared'",
);
const preparedRow = QueryRecords.fleet_handoffs.pick({ digest: true });
export function prepared(db: Database.Database, owner: string, digest: string) {
  const row = preparedStatement(db).get(owner, digest);
  return row === undefined
    ? undefined
    : parseRecord(preparedRow, row, "fleet_handoffs");
}

const commitStatement = statement(
  "UPDATE fleet_handoffs SET state='committed',result=? WHERE owner_id=? AND digest=?",
);
export function commit(
  db: Database.Database,
  result: string,
  owner: string,
  digest: string,
) {
  return commitStatement(db).run(result, owner, digest);
}

const committedStatement = statement(
  "SELECT proposal,result FROM fleet_handoffs WHERE owner_id=? AND digest=? AND state='committed'",
);
const committedRow = QueryRecords.fleet_handoffs.pick({
  proposal: true,
  result: true,
});
export function committed(
  db: Database.Database,
  owner: string,
  digest: string,
) {
  const row = committedStatement(db).get(owner, digest);
  return row === undefined
    ? undefined
    : parseRecord(committedRow, row, "fleet_handoffs");
}

const commitPreparedStatement = statement(
  "UPDATE fleet_handoffs SET state='committed',result=? WHERE owner_id=? AND digest=? AND state='prepared'",
);
export function commitPrepared(
  db: Database.Database,
  result: string,
  owner: string,
  digest: string,
) {
  return commitPreparedStatement(db).run(result, owner, digest);
}
