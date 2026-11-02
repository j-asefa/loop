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

const pendingExpiryStatement = statement(
  "SELECT expires_at FROM approvals WHERE id=? AND owner_id=? AND run_id=? AND state='pending'",
);

const pendingExpiryRow = QueryRecords.approvals.pick({ expires_at: true });

export function pendingExpiry(
  db: Database.Database,
  id: string,
  owner: string,
  run: string,
) {
  const row = pendingExpiryStatement(db).get(id, owner, run);
  return row === undefined
    ? undefined
    : parseRecord(pendingExpiryRow, row, "approvals");
}

const rejectPendingStatement = statement(
  "UPDATE approvals SET state='rejected' WHERE owner_id=? AND run_id=? AND state='pending'",
);

export function rejectPending(
  db: Database.Database,
  owner: string,
  run: string,
) {
  return rejectPendingStatement(db).run(owner, run);
}

const pendingMcpCallsStatement = statement(
  "SELECT a.id,a.run_id,c.tools,json_extract(a.request,'$.tool') AS tool FROM approvals a\n        JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id\n        JOIN mcp_connections c ON c.id=json_extract(a.request,'$.connectionId') AND c.owner_id=a.owner_id\n        WHERE a.owner_id=? AND a.state='pending' AND a.expires_at>?\n          AND r.state='awaiting_approval' AND c.status='connected'\n          AND json_extract(a.request,'$.type')='mcp_tool'",
);

const pendingMcpCallsRow = QueryRecords.approvals
  .pick({ id: true, run_id: true })
  .extend({ tools: z.string(), tool: z.string() });

export function pendingMcpCalls(
  db: Database.Database,
  owner: string,
  time: number,
) {
  return pendingMcpCallsStatement(db)
    .all(owner, time)
    .map((row) => parseRecord(pendingMcpCallsRow, row, "approvals"));
}

const approveUnexpiredStatement = statement(
  "UPDATE approvals SET state='approved' WHERE id=? AND state='pending' AND expires_at>?",
);
export function approveUnexpired(
  db: Database.Database,
  id: string,
  time: number,
) {
  return approveUnexpiredStatement(db).run(id, time);
}

const startApprovedStatement = statement(
  "UPDATE approvals SET state='executing' WHERE id=? AND state='approved'",
);
export function startApproved(db: Database.Database, id: string) {
  return startApprovedStatement(db).run(id);
}

const completeResultStatement = statement(
  "UPDATE approvals SET state='completed',result=? WHERE id=?",
);
export function completeResult(
  db: Database.Database,
  result: string,
  id: string,
) {
  return completeResultStatement(db).run(result, id);
}

const unknownExecutingStatement = statement(
  "UPDATE approvals SET state='unknown',result=? WHERE id=? AND state='executing'",
);
export function unknownExecuting(
  db: Database.Database,
  result: string,
  id: string,
) {
  return unknownExecutingStatement(db).run(result, id);
}

const ownedRunDigestExistsStatement = statement(
  "SELECT 1 FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.run_id=? AND a.digest=?",
);

const ownedRunDigestExistsRow = z.object({ "1": z.number() });

export function ownedRunDigestExists(
  db: Database.Database,
  id: string,
  owner: string,
  run: string,
  digest: string,
) {
  const row = ownedRunDigestExistsStatement(db).get(id, owner, run, digest);
  return row === undefined
    ? undefined
    : parseRecord(ownedRunDigestExistsRow, row, "approvals");
}

const pendingWebhookStatement = statement(
  "SELECT id FROM approvals WHERE run_id=? AND owner_id=? AND state='pending' ORDER BY created_at,id LIMIT 1",
);

const pendingWebhookRow = QueryRecords.approvals.pick({ id: true });

export function pendingWebhook(
  db: Database.Database,
  run: string,
  owner: string,
) {
  const row = pendingWebhookStatement(db).get(run, owner);
  return row === undefined
    ? undefined
    : parseRecord(pendingWebhookRow, row, "approvals");
}
