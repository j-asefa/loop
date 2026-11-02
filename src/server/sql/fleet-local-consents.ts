import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const acceptedHeadStatement = statement(
  "SELECT 1 FROM fleet_local_consents WHERE owner_id=? AND accepted_head=?",
);
const acceptedHeadRow = z.object({ "1": z.number() });
export function acceptedHead(
  db: Database.Database,
  owner: string,
  digest: string,
) {
  const row = acceptedHeadStatement(db).get(owner, digest);
  return row === undefined
    ? undefined
    : parseRecord(acceptedHeadRow, row, "fleet_local_consents");
}

const grantStatement = statement(
  "SELECT 1 FROM fleet_local_consents WHERE owner_id=? AND grant_id=?",
);
const grantRow = z.object({ "1": z.number() });
export function grant(db: Database.Database, owner: string, grant: string) {
  const row = grantStatement(db).get(owner, grant);
  return row === undefined
    ? undefined
    : parseRecord(grantRow, row, "fleet_local_consents");
}

const insertStatement = statement(
  "INSERT INTO fleet_local_consents VALUES(?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  consent: string,
  kind: string,
  previous: string | null,
  accepted: string,
  grant: string,
  scope: string,
  created: number,
) {
  return insertStatement(db).run(
    owner,
    consent,
    kind,
    previous,
    accepted,
    grant,
    scope,
    created,
  );
}

const recoveryParentStatement = statement(
  "SELECT previous_head FROM fleet_local_consents WHERE owner_id=? AND grant_id=? AND kind='recover'",
);
const recoveryParentRow = QueryRecords.fleet_local_consents.pick({
  previous_head: true,
});
export function recoveryParent(
  db: Database.Database,
  owner: string,
  grant: string,
) {
  const row = recoveryParentStatement(db).get(owner, grant);
  return row === undefined
    ? undefined
    : parseRecord(recoveryParentRow, row, "fleet_local_consents");
}
