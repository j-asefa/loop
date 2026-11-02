import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const mutationStatement = statement(
  "SELECT action,payload_digest,result FROM fleet_admin_receipts WHERE owner_id=? AND mutation_id=?",
);
const mutationRow = QueryRecords.fleet_admin_receipts.pick({
  action: true,
  payload_digest: true,
  result: true,
});
export function mutation(
  db: Database.Database,
  owner: string,
  mutation: string,
) {
  const row = mutationStatement(db).get(owner, mutation);
  return row === undefined
    ? undefined
    : parseRecord(mutationRow, row, "fleet_admin_receipts");
}

const insertStatement = statement(
  "INSERT INTO fleet_admin_receipts VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  mutation: string,
  action: string,
  digest: string,
  result: string,
) {
  return insertStatement(db).run(owner, mutation, action, digest, result);
}
