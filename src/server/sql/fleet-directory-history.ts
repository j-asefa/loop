import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const digestsStatement = statement(
  "SELECT digest FROM fleet_directory_history WHERE owner_id=? ORDER BY rowid",
);
const digestsRow = QueryRecords.fleet_directory_history.pick({ digest: true });
export function digests(db: Database.Database, owner: string) {
  return digestsStatement(db)
    .all(owner)
    .map((row) => parseRecord(digestsRow, row, "fleet_directory_history"));
}

const existsStatement = statement(
  "SELECT 1 FROM fleet_directory_history WHERE owner_id=? AND digest=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, owner: string, digest: string) {
  const row = existsStatement(db).get(owner, digest);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "fleet_directory_history");
}

const signedStatement = statement(
  "SELECT signed FROM fleet_directory_history WHERE owner_id=? AND digest=?",
);
const signedRow = QueryRecords.fleet_directory_history.pick({ signed: true });
export function signed(db: Database.Database, owner: string, digest: string) {
  const row = signedStatement(db).get(owner, digest);
  return row === undefined
    ? undefined
    : parseRecord(signedRow, row, "fleet_directory_history");
}

const mutationStatement = statement(
  "SELECT digest FROM fleet_directory_history WHERE owner_id=? AND fleet_id=? AND mutation_id=?",
);
const mutationRow = QueryRecords.fleet_directory_history.pick({ digest: true });
export function mutation(
  db: Database.Database,
  owner: string,
  fleet: string,
  mutation: string,
) {
  const row = mutationStatement(db).get(owner, fleet, mutation);
  return row === undefined
    ? undefined
    : parseRecord(mutationRow, row, "fleet_directory_history");
}

const insertStatement = statement(
  "INSERT OR IGNORE INTO fleet_directory_history VALUES(?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  digest: string,
  fleet: string,
  mutation: string,
  signed: string,
  accepted: number,
) {
  return insertStatement(db).run(
    owner,
    digest,
    fleet,
    mutation,
    signed,
    accepted,
  );
}
