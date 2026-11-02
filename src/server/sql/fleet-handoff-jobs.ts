import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const pageStatement = statement(
  "SELECT operation_id,created_at FROM fleet_handoff_jobs WHERE owner_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND operation_id<?)) ORDER BY created_at DESC,operation_id DESC LIMIT 51",
);
const pageRow = QueryRecords.fleet_handoff_jobs.pick({
  operation_id: true,
  created_at: true,
});
export function page(
  db: Database.Database,
  owner: string,
  cursor: number | null,
  before: number,
  sameTime: number,
  operation: string,
) {
  return pageStatement(db)
    .all(owner, cursor, before, sameTime, operation)
    .map((row) => parseRecord(pageRow, row, "fleet_handoff_jobs"));
}

const recoverStatement = statement(
  "UPDATE fleet_handoff_jobs SET attempt_id=NULL WHERE owner_id=? AND state='uncertain'",
);
export function recover(db: Database.Database, owner: string) {
  return recoverStatement(db).run(owner);
}

const getStatement = statement(
  "SELECT * FROM fleet_handoff_jobs WHERE owner_id=? AND operation_id=?",
);
const getRow = QueryRecords.fleet_handoff_jobs;
export function get(db: Database.Database, owner: string, operation: string) {
  const row = getStatement(db).get(owner, operation);
  return row === undefined
    ? undefined
    : parseRecord(getRow, row, "fleet_handoff_jobs");
}

const inputDigestStatement = statement(
  "SELECT input_digest FROM fleet_handoff_jobs WHERE owner_id=? AND operation_id=?",
);
const inputDigestRow = QueryRecords.fleet_handoff_jobs.pick({
  input_digest: true,
});
export function inputDigest(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  const row = inputDigestStatement(db).get(owner, operation);
  return row === undefined
    ? undefined
    : parseRecord(inputDigestRow, row, "fleet_handoff_jobs");
}

const insertStatement = statement(
  "INSERT INTO fleet_handoff_jobs(owner_id,operation_id,input,input_digest,proposal,directory_digest,origin,state,created_at) VALUES(?,?,?,?,?,?,?,'ready',?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  operation: string,
  input: string,
  inputDigest: string,
  proposal: string,
  digest: string,
  origin: string,
  created: number,
) {
  return insertStatement(db).run(
    owner,
    operation,
    input,
    inputDigest,
    proposal,
    digest,
    origin,
    created,
  );
}

const completeStatement = statement(
  "UPDATE fleet_handoff_jobs SET state='complete',attempt_id=NULL,result=? WHERE owner_id=? AND operation_id=?",
);
export function complete(
  db: Database.Database,
  result: string,
  owner: string,
  operation: string,
) {
  return completeStatement(db).run(result, owner, operation);
}

const supersedeStatement = statement(
  "UPDATE fleet_handoff_jobs SET state='superseded' WHERE owner_id=? AND operation_id=? AND state='ready'",
);
export function supersede(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  return supersedeStatement(db).run(owner, operation);
}

const claimStatement = statement(
  "UPDATE fleet_handoff_jobs SET state='uncertain',attempt_id=? WHERE owner_id=? AND operation_id=? AND state='ready'",
);
export function claim(
  db: Database.Database,
  attempt: string,
  owner: string,
  operation: string,
) {
  return claimStatement(db).run(attempt, owner, operation);
}
