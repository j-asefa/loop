import type Database from "better-sqlite3";
import { QueryRecords, type QueryRow } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

export type BeadAssignment = QueryRow<"bead_assignments">;
const parse = (row: unknown) =>
  parseRecord(QueryRecords.bead_assignments, row, "bead_assignments");
const maybe = (row: unknown) => (row === undefined ? undefined : parse(row));

const request = statement(
  "SELECT * FROM bead_assignments WHERE owner_id=? AND request_id=?",
);
export function byRequest(db: Database.Database, owner: string, id: string) {
  return maybe(request(db).get(owner, id));
}

const generation = statement(
  "SELECT * FROM bead_assignments WHERE owner_id=? AND store_id=? AND bead_id=? AND generation=?",
);
export function byGeneration(
  db: Database.Database,
  owner: string,
  store: string,
  bead: string,
  identity: string,
) {
  return maybe(generation(db).get(owner, store, bead, identity));
}

const current = statement(
  "SELECT * FROM bead_assignments WHERE owner_id=? AND store_id=? AND bead_id=? AND state NOT IN ('released','refused')",
);
export function active(
  db: Database.Database,
  owner: string,
  store: string,
  bead: string,
) {
  return maybe(current(db).get(owner, store, bead));
}

const list = statement(
  "SELECT * FROM bead_assignments WHERE owner_id=? AND store_id=? AND bead_id=? AND run_id IS NOT NULL ORDER BY created_at,request_id",
);
export function forBead(
  db: Database.Database,
  owner: string,
  store: string,
  bead: string,
) {
  return list(db).all(owner, store, bead).map(parse);
}

const run = statement(
  "SELECT * FROM bead_assignments WHERE owner_id=? AND run_id=?",
);
export function forRun(db: Database.Database, owner: string, runId: string) {
  return maybe(run(db).get(owner, runId));
}

const insert = statement(
  `INSERT INTO bead_assignments(owner_id,store_id,bead_id,request_id,generation,agent_id,state,created_at)
  VALUES(@owner_id,@store_id,@bead_id,@request_id,@generation,@agent_id,'prepared',@created_at)`,
);
export function prepare(
  db: Database.Database,
  input: Omit<BeadAssignment, "state" | "run_id">,
) {
  insert(db).run(input);
}

const update = statement(
  "UPDATE bead_assignments SET state=?,run_id=? WHERE owner_id=? AND request_id=? AND generation=? AND state=?",
);
export function transition(
  db: Database.Database,
  row: BeadAssignment,
  state: BeadAssignment["state"],
  runId = row.run_id,
) {
  return (
    update(db).run(
      state,
      runId,
      row.owner_id,
      row.request_id,
      row.generation,
      row.state,
    ).changes === 1
  );
}
