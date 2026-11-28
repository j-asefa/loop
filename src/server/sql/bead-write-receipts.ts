import type Database from "better-sqlite3";
import { QueryRecords, type QueryRow } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const schema = QueryRecords.bead_write_receipts;
const parse = (row: unknown) => parseRecord(schema, row, "bead_write_receipts");

const read = statement(
  "SELECT * FROM bead_write_receipts WHERE owner_id=? AND request_id=?",
);
export function byRequest(
  db: Database.Database,
  owner: string,
  request: string,
) {
  const row = read(db).get(owner, request);
  return row === undefined ? undefined : parse(row);
}

const createSource = statement(
  "SELECT * FROM bead_write_receipts WHERE owner_id=? AND store_id=? AND bead_id=? AND operation='create'",
);
export function creation(
  db: Database.Database,
  owner: string,
  store: string,
  bead: string,
) {
  const row = createSource(db).get(owner, store, bead);
  return row === undefined ? undefined : parse(row);
}

const insert = statement(
  `INSERT INTO bead_write_receipts(owner_id,request_id,store_id,operation,request_hash,bead_id,correlation_id,source_result_id)
  VALUES(@owner_id,@request_id,@store_id,@operation,@request_hash,@bead_id,@correlation_id,@source_result_id)`,
);
export function reserve(
  db: Database.Database,
  row: Omit<QueryRow<"bead_write_receipts">, "completed_at">,
) {
  insert(db).run(row);
}

const complete = statement(
  "UPDATE bead_write_receipts SET completed_at=COALESCE(completed_at,?) WHERE owner_id=? AND request_id=? AND correlation_id=?",
);
export function finish(
  db: Database.Database,
  owner: string,
  request: string,
  marker: string,
  now: number,
) {
  complete(db).run(now, owner, request, marker);
}

const forget = statement(
  "DELETE FROM bead_write_receipts WHERE owner_id=? AND request_id=? AND correlation_id=? AND completed_at IS NULL",
);
export function forgetPending(
  db: Database.Database,
  owner: string,
  request: string,
  marker: string,
) {
  forget(db).run(owner, request, marker);
}
