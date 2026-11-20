import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Queries for the vm_operations table (docs/architecture.md#recipe-add-or-extend-a-sql-table-module).
// state is written only through insertPending and setState, called by
// vm/machine.ts (docs/state-machines.md#vm_operationsstate).

const parse = (row: unknown) =>
  parseRecord(QueryRecords.vm_operations, row, "vm_operations");

const insertPendingStatement = statement(
  "INSERT INTO vm_operations(id,owner_id,experiment_id,kind,state,request_digest,request_json,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?,?)",
);
export function insertPending(
  db: Database.Database,
  operation: {
    id: string;
    owner: string;
    experimentId: string;
    kind: string;
    requestDigest: string;
    requestJson: string;
    now: number;
  },
) {
  insertPendingStatement(db).run(
    operation.id,
    operation.owner,
    operation.experimentId,
    operation.kind,
    operation.requestDigest,
    operation.requestJson,
    operation.now,
    operation.now,
  );
}

const byIdStatement = statement(
  "SELECT * FROM vm_operations WHERE owner_id=? AND id=?",
);
export function byId(db: Database.Database, owner: string, id: string) {
  const row = byIdStatement(db).get(owner, id);
  return row === undefined ? undefined : parse(row);
}

const idTakenStatement = statement("SELECT 1 FROM vm_operations WHERE id=?");
/** Whether any owner holds this id, without revealing whose it is. */
export function idTaken(db: Database.Database, id: string) {
  return idTakenStatement(db).get(id) !== undefined;
}

const unsettledByExperimentStatement = statement(
  "SELECT * FROM vm_operations WHERE owner_id=? AND experiment_id=? AND state IN ('pending','uncertain') ORDER BY created_at, id",
);
export function unsettledByExperiment(
  db: Database.Database,
  owner: string,
  experiment: string,
) {
  return unsettledByExperimentStatement(db).all(owner, experiment).map(parse);
}

const setStateStatement = statement(
  "UPDATE vm_operations SET state=?,result_json=?,error_message=?,updated_at=? WHERE owner_id=? AND id=? AND state=?",
);
/** Moves `from` to `to`; returns false when the row is no longer in `from`. */
export function setState(
  db: Database.Database,
  owner: string,
  id: string,
  from: string,
  to: string,
  outcome: { resultJson: string | null; errorMessage: string | null },
  now: number,
) {
  return (
    setStateStatement(db).run(
      to,
      outcome.resultJson,
      outcome.errorMessage,
      now,
      owner,
      id,
      from,
    ).changes === 1
  );
}

const pendingIdsStatement = statement(
  "SELECT id,owner_id FROM vm_operations WHERE state='pending' AND updated_at<? ORDER BY created_at, id",
);
const pendingIdRow = QueryRecords.vm_operations.pick({
  id: true,
  owner_id: true,
});
/** Every owner's receipts still pending since before \`cutoff\`, for the
 * recovery sweep only. */
export function pendingBefore(db: Database.Database, cutoff: number) {
  return pendingIdsStatement(db)
    .all(cutoff)
    .map((row) => parseRecord(pendingIdRow, row, "vm_operations"));
}
