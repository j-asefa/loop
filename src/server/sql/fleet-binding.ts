import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownerStatement = statement(
  "SELECT owner_id FROM fleet_binding WHERE singleton=1",
);
const ownerRow = QueryRecords.fleet_binding.pick({ owner_id: true });
export function owner(db: Database.Database) {
  const row = ownerStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(ownerRow, row, "fleet_binding");
}

const currentStatement = statement(
  "SELECT * FROM fleet_binding WHERE singleton=1",
);
const currentRow = QueryRecords.fleet_binding;
export function current(db: Database.Database) {
  const row = currentStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(currentRow, row, "fleet_binding");
}

const installStatement = statement(
  "INSERT INTO fleet_binding VALUES(1,?,?,?,?,?,?)\n      ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,fleet_id=excluded.fleet_id,\n      grant_id=excluded.grant_id,scope=excluded.scope,head=excluded.head,state=excluded.state",
);
export function install(
  db: Database.Database,
  owner: string,
  fleet: string,
  grant: string,
  scope: string,
  head: string,
  state: string,
) {
  return installStatement(db).run(owner, fleet, grant, scope, head, state);
}

const handoffPendingStatement = statement(
  "UPDATE fleet_binding SET state='handoff_pending' WHERE singleton=1",
);
export function handoffPending(db: Database.Database) {
  return handoffPendingStatement(db).run();
}

const ownerGrantStatement = statement(
  "SELECT scope,grant_id FROM fleet_binding WHERE owner_id=?",
);
const ownerGrantRow = QueryRecords.fleet_binding.pick({
  scope: true,
  grant_id: true,
});
export function ownerGrant(db: Database.Database, owner: string) {
  const row = ownerGrantStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(ownerGrantRow, row, "fleet_binding");
}

const ownerScopeStatement = statement(
  "SELECT scope FROM fleet_binding WHERE owner_id=?",
);
const ownerScopeRow = QueryRecords.fleet_binding.pick({ scope: true });
export function ownerScope(db: Database.Database, owner: string) {
  const row = ownerScopeStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(ownerScopeRow, row, "fleet_binding");
}
