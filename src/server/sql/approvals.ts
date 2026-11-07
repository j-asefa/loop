import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

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

// A crash during a tool call leaves the approval 'executing' forever. Once
// its run is no longer actively executing (recovered, ended), mark it
// 'unknown' so the stored state reflects the uncertain outcome (#355 S1).
const sweepExecutingStatement = statement(
  "UPDATE approvals SET state='unknown',result=? WHERE state='executing' AND run_id IN (SELECT id FROM runs WHERE state NOT IN ('running','pausing'))",
);
export function sweepExecuting(db: Database.Database, result: string) {
  return sweepExecutingStatement(db).run(result);
}

const unknownExecutingStatement = statement(
  "UPDATE approvals SET state='unknown',result=? WHERE id=? AND state IN ('executing','unknown')",
);
export function unknownExecuting(
  db: Database.Database,
  result: string,
  id: string,
) {
  return unknownExecutingStatement(db).run(result, id);
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

const pendingTeamsStatements = statementVariants();
const pendingTeamsRow = QueryRecords.approvals.extend({
  conversation_id: z.string().nullable(),
  input: z.string(),
  name: z.string().nullable(),
  provider: z.string().nullable(),
});
export function pendingTeams(
  db: Database.Database,
  owner: string,
  teams: readonly string[],
) {
  const filter = teams.length
    ? " AND json_extract(r.payload,'$.teamId') IN (" +
      teams.map(() => "?").join(",") +
      ")"
    : "";
  return pendingTeamsStatements(
    "SELECT a.*,r.conversation_id,r.input,agent.name,agent.provider FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id LEFT JOIN agents agent ON agent.id=r.agent_id AND agent.owner_id=a.owner_id WHERE a.owner_id=? AND a.state='pending' AND r.state='awaiting_approval'" +
      filter +
      " ORDER BY a.created_at",
    db,
  )
    .all(owner, ...teams)
    .map((row) => parseRecord(pendingTeamsRow, row, "approvals"));
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

const feedPendingStatement = statement(
  "SELECT a.id,a.run_id,a.expires_at,COALESCE(\n    (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=@conversation AND m.run_id=a.run_id AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),\n    (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=@conversation AND m.run_id=a.run_id AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at,m.rowid LIMIT 1)) message_id\n    FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id\n    WHERE a.owner_id=@owner AND r.conversation_id=@conversation AND r.state='awaiting_approval' AND a.state='pending'\n    ORDER BY a.created_at,a.rowid",
);
const feedPendingRow = QueryRecords.approvals
  .pick({ id: true, run_id: true, expires_at: true })
  .extend({ message_id: z.string().nullable() });
export function feedPending(
  db: Database.Database,
  args: { owner: string; conversation: string },
) {
  return feedPendingStatement(db)
    .all(args)
    .map((row) => parseRecord(feedPendingRow, row, "approvals"));
}

const previewDecisionStatement = statement(
  "UPDATE approvals SET state=?,result=? WHERE id=?",
);
export function previewDecision(
  db: Database.Database,
  state: string,
  result: string,
  id: string,
) {
  return previewDecisionStatement(db).run(state, result, id);
}

const insertPreviewStatement = statement(
  "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?)",
);
export function insertPreview(
  db: Database.Database,
  id: string,
  owner: string,
  run: string,
  digest: string,
  request: string,
  created: number,
  expires: number,
) {
  return insertPreviewStatement(db).run(
    id,
    owner,
    run,
    digest,
    request,
    created,
    expires,
  );
}
