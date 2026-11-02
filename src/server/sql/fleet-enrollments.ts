import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const sourcePageStatement = statement(
  "SELECT operation_id,created_at FROM fleet_enrollments WHERE owner_id=? AND role='source' AND (? IS NULL OR created_at<? OR (created_at=? AND operation_id<?)) ORDER BY created_at DESC,operation_id DESC LIMIT 51",
);
const sourcePageRow = QueryRecords.fleet_enrollments.pick({
  operation_id: true,
  created_at: true,
});
export function sourcePage(
  db: Database.Database,
  owner: string,
  cursor: number | null,
  before: number,
  sameTime: number,
  operation: string,
) {
  return sourcePageStatement(db)
    .all(owner, cursor, before, sameTime, operation)
    .map((row) => parseRecord(sourcePageRow, row, "fleet_enrollments"));
}

const preparedPageStatement = statement(
  "SELECT operation_id,request,prepared FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND state='prepared' AND (? IS NULL OR operation_id>?) ORDER BY operation_id LIMIT 51",
);
const preparedPageRow = QueryRecords.fleet_enrollments.pick({
  operation_id: true,
  request: true,
  prepared: true,
});
export function preparedPage(
  db: Database.Database,
  owner: string,
  cursor: string | null,
  sameCursor: string | null,
) {
  return preparedPageStatement(db)
    .all(owner, cursor, sameCursor)
    .map((row) => parseRecord(preparedPageRow, row, "fleet_enrollments"));
}

const recoverSourceStatement = statement(
  "UPDATE fleet_enrollments SET state='uncertain',attempt_id=NULL WHERE owner_id=? AND role='source' AND state IN ('preparing','uncertain')",
);
export function recoverSource(db: Database.Database, owner: string) {
  return recoverSourceStatement(db).run(owner);
}

const sourceStatement = statement(
  "SELECT * FROM fleet_enrollments WHERE owner_id=? AND role='source' AND operation_id=?",
);
const sourceRow = QueryRecords.fleet_enrollments;
export function source(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  const row = sourceStatement(db).get(owner, operation);
  return row === undefined
    ? undefined
    : parseRecord(sourceRow, row, "fleet_enrollments");
}

const recentSourcesStatement = statement(
  "SELECT operation_id FROM fleet_enrollments WHERE owner_id=? AND role='source' ORDER BY created_at DESC,operation_id LIMIT 50",
);
const recentSourcesRow = QueryRecords.fleet_enrollments.pick({
  operation_id: true,
});
export function recentSources(db: Database.Database, owner: string) {
  return recentSourcesStatement(db)
    .all(owner)
    .map((row) => parseRecord(recentSourcesRow, row, "fleet_enrollments"));
}

const sourceExistsStatement = statement(
  "SELECT 1 FROM fleet_enrollments WHERE owner_id=? AND role='source' AND operation_id=?",
);
const sourceExistsRow = z.object({ "1": z.number() });
export function sourceExists(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  const row = sourceExistsStatement(db).get(owner, operation);
  return row === undefined
    ? undefined
    : parseRecord(sourceExistsRow, row, "fleet_enrollments");
}

const insertSourceStatement = statement(
  "INSERT INTO fleet_enrollments(owner_id,operation_id,role,request_digest,local_input_digest,request,capability,prepared,committed,state,created_at) VALUES(?,?,'source',?,?,?,?,NULL,NULL,'ready',?)",
);
export function insertSource(
  db: Database.Database,
  owner: string,
  operation: string,
  digest: string,
  inputDigest: string,
  request: string,
  capability: string,
  created: number,
) {
  return insertSourceStatement(db).run(
    owner,
    operation,
    digest,
    inputDigest,
    request,
    capability,
    created,
  );
}

const publishSourceStatement = statement(
  "UPDATE fleet_enrollments SET committed=?,state='published',capability=NULL,attempt_id=NULL WHERE owner_id=? AND role='source' AND operation_id=?",
);
export function publishSource(
  db: Database.Database,
  committed: string,
  owner: string,
  operation: string,
) {
  return publishSourceStatement(db).run(committed, owner, operation);
}

const sourceReceiptStatement = statement(
  "UPDATE fleet_enrollments SET state=?,prepared=?,receipt=?,capability=NULL,attempt_id=? WHERE owner_id=? AND role='source' AND operation_id=?",
);
export function sourceReceipt(
  db: Database.Database,
  state: string,
  prepared: string,
  receipt: string,
  attempt: string | null,
  owner: string,
  operation: string,
) {
  return sourceReceiptStatement(db).run(
    state,
    prepared,
    receipt,
    attempt,
    owner,
    operation,
  );
}

const claimSourceStatement = statement(
  "UPDATE fleet_enrollments SET state='preparing',attempt_id=?,capability=NULL WHERE owner_id=? AND role='source' AND operation_id=? AND state='ready' AND EXISTS(SELECT 1 FROM fleet_enrollment_instances WHERE owner_id=? AND instance_id=?)",
);
export function claimSource(
  db: Database.Database,
  attempt: string,
  owner: string,
  operation: string,
  instanceOwner: string,
  instance: string,
) {
  return claimSourceStatement(db).run(
    attempt,
    owner,
    operation,
    instanceOwner,
    instance,
  );
}

const sourcePreparedStatement = statement(
  "UPDATE fleet_enrollments SET state='prepared',prepared=?,attempt_id=NULL WHERE owner_id=? AND role='source' AND operation_id=? AND state='preparing' AND attempt_id=?",
);
export function sourcePrepared(
  db: Database.Database,
  prepared: string,
  owner: string,
  operation: string,
  attempt: string,
) {
  return sourcePreparedStatement(db).run(prepared, owner, operation, attempt);
}

const sourceUncertainStatement = statement(
  "UPDATE fleet_enrollments SET state='uncertain',attempt_id=NULL WHERE owner_id=? AND role='source' AND operation_id=? AND state='preparing' AND attempt_id=?",
);
export function sourceUncertain(
  db: Database.Database,
  owner: string,
  operation: string,
  attempt: string,
) {
  return sourceUncertainStatement(db).run(owner, operation, attempt);
}

const cancelPublishedSourceStatement = statement(
  "UPDATE fleet_enrollments SET state='cancelled',attempt_id=NULL WHERE owner_id=? AND role='source' AND operation_id=? AND state='published'",
);
export function cancelPublishedSource(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  return cancelPublishedSourceStatement(db).run(owner, operation);
}

const claimPublishedSourceStatement = statement(
  "UPDATE fleet_enrollments SET state='uncertain',attempt_id=? WHERE owner_id=? AND role='source' AND operation_id=? AND state='published'",
);
export function claimPublishedSource(
  db: Database.Database,
  attempt: string,
  owner: string,
  operation: string,
) {
  return claimPublishedSourceStatement(db).run(attempt, owner, operation);
}

const releaseSourceStatement = statement(
  "UPDATE fleet_enrollments SET attempt_id=NULL WHERE owner_id=? AND role='source' AND operation_id=? AND attempt_id=?",
);
export function releaseSource(
  db: Database.Database,
  owner: string,
  operation: string,
  attempt: string,
) {
  return releaseSourceStatement(db).run(owner, operation, attempt);
}

const cancelSourceStatement = statement(
  "UPDATE fleet_enrollments SET state='cancelled',capability=NULL,attempt_id=NULL WHERE owner_id=? AND role='source' AND operation_id=?",
);
export function cancelSource(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  return cancelSourceStatement(db).run(owner, operation);
}

const destinationStatement = statement(
  "SELECT * FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND operation_id=?",
);
const destinationRow = QueryRecords.fleet_enrollments;
export function destination(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  const row = destinationStatement(db).get(owner, operation);
  return row === undefined
    ? undefined
    : parseRecord(destinationRow, row, "fleet_enrollments");
}

const latestDestinationGrantStatement = statement(
  "SELECT operation_id FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND json_extract(prepared,'$.prepared.member.grantId')=? ORDER BY rowid DESC LIMIT 1",
);
const latestDestinationGrantRow = QueryRecords.fleet_enrollments.pick({
  operation_id: true,
});
export function latestDestinationGrant(
  db: Database.Database,
  owner: string,
  grant: string,
) {
  const row = latestDestinationGrantStatement(db).get(owner, grant);
  return row === undefined
    ? undefined
    : parseRecord(latestDestinationGrantRow, row, "fleet_enrollments");
}

const destinationGrantStatement = statement(
  "SELECT operation_id FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND state IN ('prepared','cancelled') AND json_extract(prepared,'$.prepared.member.grantId')=?",
);
const destinationGrantRow = QueryRecords.fleet_enrollments.pick({
  operation_id: true,
});
export function destinationGrant(
  db: Database.Database,
  owner: string,
  grant: string,
) {
  return destinationGrantStatement(db)
    .all(owner, grant)
    .map((row) => parseRecord(destinationGrantRow, row, "fleet_enrollments"));
}

const cancelPreparedDestinationsStatement = statement(
  "UPDATE fleet_enrollments SET state='cancelled' WHERE owner_id=? AND role='destination' AND state='prepared'",
);
export function cancelPreparedDestinations(
  db: Database.Database,
  owner: string,
) {
  return cancelPreparedDestinationsStatement(db).run(owner);
}

const insertDestinationStatement = statement(
  "INSERT INTO fleet_enrollments(owner_id,operation_id,role,request_digest,request,capability,prepared,committed,state) VALUES(?,?,'destination',?,?,NULL,?,NULL,'prepared')",
);
export function insertDestination(
  db: Database.Database,
  owner: string,
  operation: string,
  digest: string,
  request: string,
  prepared: string,
) {
  return insertDestinationStatement(db).run(
    owner,
    operation,
    digest,
    request,
    prepared,
  );
}

const completeDestinationStatement = statement(
  "UPDATE fleet_enrollments SET state='complete',committed=? WHERE owner_id=? AND role='destination' AND operation_id=?",
);
export function completeDestination(
  db: Database.Database,
  committed: string,
  owner: string,
  operation: string,
) {
  return completeDestinationStatement(db).run(committed, owner, operation);
}

const cancelPreparedDestinationStatement = statement(
  "UPDATE fleet_enrollments SET state='cancelled' WHERE owner_id=? AND role='destination' AND operation_id=? AND state='prepared'",
);
export function cancelPreparedDestination(
  db: Database.Database,
  owner: string,
  operation: string,
) {
  return cancelPreparedDestinationStatement(db).run(owner, operation);
}

const latestSelectedDestinationGrantStatement = statement(
  "SELECT operation_id FROM fleet_enrollments WHERE owner_id=? AND role='destination' AND json_extract(prepared,'$.prepared.member.grantId')=? AND operation_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT 1",
);
const latestSelectedDestinationGrantRow = QueryRecords.fleet_enrollments.pick({
  operation_id: true,
});
export function latestSelectedDestinationGrant(
  db: Database.Database,
  owner: string,
  grant: string,
  operations: string,
) {
  const row = latestSelectedDestinationGrantStatement(db).get(
    owner,
    grant,
    operations,
  );
  return row === undefined
    ? undefined
    : parseRecord(latestSelectedDestinationGrantRow, row, "fleet_enrollments");
}
