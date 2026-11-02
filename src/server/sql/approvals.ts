import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const existsOwnedStatement = statement(
  "SELECT 1 FROM approvals WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(db: Database.Database, id: string, owner: string) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "approvals");
}

const ownedStatement = statement(
  "SELECT * FROM approvals WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.approvals, row, "approvals");
}

const completeStatement = statement(
  "UPDATE approvals SET state='completed',result=? WHERE id=?",
);
export function complete(
  db: Database.Database,
  result: string,
  approval: string,
) {
  return completeStatement(db).run(result, approval);
}

const byDigestStatement = statement(
  "SELECT * FROM approvals WHERE owner_id=? AND run_id=? AND digest=?",
);
const byDigestRow = QueryRecords.approvals;
export function byDigest(
  db: Database.Database,
  owner: string,
  run: string,
  digest: string,
) {
  const row = byDigestStatement(db).get(owner, run, digest);
  return row === undefined
    ? undefined
    : parseRecord(byDigestRow, row, "approvals");
}

const insertStatement = statement(
  "INSERT INTO approvals VALUES(?,?,?,?,?,?,NULL,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  run: string,
  digest: string,
  action: string,
  state: string,
  created: number,
  expires: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    run,
    digest,
    action,
    state,
    created,
    expires,
  );
}

const decideStatement = statement(
  "UPDATE approvals SET state=? WHERE id=? AND state=?",
);
export function decide(
  db: Database.Database,
  decision: string,
  id: string,
  previous: string,
) {
  return decideStatement(db).run(decision, id, previous);
}
