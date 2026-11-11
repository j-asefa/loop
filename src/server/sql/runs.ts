import {
  ACTIVE_RUN_DISPLAY_STATES_SQL,
  ACTIVE_RUN_STATES_SQL,
  EXECUTING_RUN_STATES_SQL,
  TERMINAL_RUN_STATES_SQL,
  publicRunStateSql,
} from "../../shared/run-state.js";
import { FOLDER_PROJECT } from "./folders.js";
import { LIVE_INPUT_HARNESSES, NATIVE_CONNECTION_SQL } from "./connections.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord, parseRun, InvalidRow, type Run } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";
import { READY_REVIEW_CONTINUATION } from "./review-continuations.js";

const RUN_LIVE_INPUT_SQL = (r: string) =>
  `(EXISTS(SELECT 1 FROM connections lc WHERE lc.id=json_extract(${r}.payload,'$.connectionId') AND lc.owner_id=${r}.owner_id AND COALESCE(json_extract(lc.metadata,'$.loopHarness'),'') IN ('',${[...LIVE_INPUT_HARNESSES].map((h) => `'${h}'`).join(",")})))`;

const perConversation = (r: string) =>
  `EXISTS(SELECT 1 FROM connections c WHERE c.id=json_extract(${r}.payload,'$.connectionId') AND c.owner_id=${r}.owner_id AND ${NATIVE_CONNECTION_SQL})`;

export const RunIdentity = z.object({
  id: z.string().min(1),
  owner_id: z.string().min(1),
});

const hasReviewInConversationStatement = statement(
  "SELECT 1 FROM runs WHERE conversation_id=? AND owner_id=? AND json_extract(payload,'$.reviewId') IS NOT NULL LIMIT 1",
);
const hasReviewInConversationRow = z.object({ "1": z.number() });
export function hasReviewInConversation(
  db: Database.Database,
  conversation: string | null,
  owner: string | null,
) {
  const row = hasReviewInConversationStatement(db).get(conversation, owner);
  return row === undefined
    ? undefined
    : parseRecord(hasReviewInConversationRow, row, "runs");
}

const mailConnectionStatement = statement(
  "SELECT json_extract(r.payload,'$.connectionId') id,c.status,a.connection_id current_id FROM runs r JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id LEFT JOIN connections c ON c.id=json_extract(r.payload,'$.connectionId') AND c.owner_id=r.owner_id WHERE r.id=?",
);
const mailConnectionRow = z.object({
  id: z.string().nullable(),
  status: z.string().nullable(),
  current_id: z.string().nullable(),
});
export function mailConnection(db: Database.Database, id: string | null) {
  const row = mailConnectionStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(mailConnectionRow, row, "runs");
}

const ownedPayloadStatement = statement(
  "SELECT id,payload FROM runs WHERE id=? AND owner_id=?",
);
const ownedPayloadRow = QueryRecords.runs.pick({ id: true, payload: true });
export function ownedPayload(
  db: Database.Database,
  id: string | null,
  owner: string | null,
) {
  const row = ownedPayloadStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedPayloadRow, row, "runs");
}

const ownedStatement = statement(
  "SELECT * FROM runs WHERE id=? AND owner_id=?",
);

export function owned(
  db: Database.Database,
  id: string | null,
  owner: string | null,
) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.runs, row, "runs");
}

const stateStatement = statement("SELECT state FROM runs WHERE id=?");
const stateRow = QueryRecords.runs.pick({ state: true });
export function state(db: Database.Database, id: string | null) {
  const row = stateStatement(db).get(id);
  return row === undefined ? undefined : parseRecord(stateRow, row, "runs");
}

const latestConversationPayloadStatement = statement(
  "SELECT id,payload FROM runs WHERE owner_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
);
const latestConversationPayloadRow = QueryRecords.runs.pick({
  id: true,
  payload: true,
});
export function latestConversationPayload(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
) {
  const row = latestConversationPayloadStatement(db).get(owner, conversation);
  return row === undefined
    ? undefined
    : parseRecord(latestConversationPayloadRow, row, "runs");
}

const steerableForAgentStatement = statement(
  "SELECT r.* FROM runs r WHERE owner_id=? AND agent_id=? AND kind='agent' AND state IN ('running','awaiting_approval') AND NOT EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.run_id=r.id AND c.stage='done') ORDER BY created_at DESC",
);

export function steerableForAgent(
  db: Database.Database,
  owner: string | null,
  agent: string | null,
) {
  return steerableForAgentStatement(db)
    .all(owner, agent)
    .map((row) => parseRecord(QueryRecords.runs, row, "runs"));
}

const byIdempotencyStatement = statement(
  "SELECT * FROM runs WHERE owner_id=? AND idempotency_key=?",
);

export function byIdempotency(
  db: Database.Database,
  owner: string | null,
  key: string | null,
) {
  const row = byIdempotencyStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.runs, row, "runs");
}

const latestConversationPayloadByRowidStatement = statement(
  "SELECT id,payload FROM runs WHERE owner_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 1",
);
const latestConversationPayloadByRowidRow = QueryRecords.runs.pick({
  id: true,
  payload: true,
});
export function latestConversationPayloadByRowid(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
) {
  const row = latestConversationPayloadByRowidStatement(db).get(
    owner,
    conversation,
  );
  return row === undefined
    ? undefined
    : parseRecord(latestConversationPayloadByRowidRow, row, "runs");
}

const latestConversationModelStatement = statement(
  "SELECT json_extract(payload,'$.model') model FROM runs WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
);
const latestConversationModelRow = z.object({ model: z.string().nullable() });
export function latestConversationModel(
  db: Database.Database,
  conversation: string | null,
) {
  const row = latestConversationModelStatement(db).get(conversation);
  return row === undefined
    ? undefined
    : parseRecord(latestConversationModelRow, row, "runs");
}

const releaseForChildrenStatement = statement(
  "UPDATE runs SET worker_id=NULL,heartbeat=NULL,active_ms=active_ms+CASE WHEN active_since IS NOT NULL THEN max(0,?-active_since) ELSE 0 END,active_since=NULL WHERE id=?",
);
export function releaseForChildren(
  db: Database.Database,
  time: number,
  id: string | null,
) {
  return releaseForChildrenStatement(db).run(time, id);
}

const setResultStatement = statement("UPDATE runs SET result=? WHERE id=?");
export function setResult(
  db: Database.Database,
  result: string | null,
  id: string | null,
) {
  return setResultStatement(db).run(result, id);
}

const resumeAfterApprovalStatement = statement(
  "UPDATE runs SET state='running' WHERE id=?",
);
export function resumeAfterApproval(db: Database.Database, id: string | null) {
  return resumeAfterApprovalStatement(db).run(id);
}

const setErrorStatement = statement("UPDATE runs SET error=? WHERE id=?");
export function setError(
  db: Database.Database,
  error: string | null,
  id: string | null,
) {
  return setErrorStatement(db).run(error, id);
}

const forAgentStatement = statement(
  "SELECT * FROM runs WHERE owner_id=? AND agent_id=? ORDER BY created_at DESC LIMIT 100",
);

export function forAgent(
  db: Database.Database,
  owner: string | null,
  agent: string | null,
) {
  return forAgentStatement(db)
    .all(owner, agent)
    .map((row) => parseRecord(QueryRecords.runs, row, "runs"));
}

const completePreviewStatement =
  statement(`UPDATE runs SET result=@result,state='completed',worker_id=NULL,heartbeat=NULL,updated_at=@time,
      active_ms=active_ms+CASE WHEN active_since IS NOT NULL THEN max(0,@time-active_since) ELSE 0 END,
      active_since=NULL WHERE id=@id AND owner_id=@owner`);
export function completePreview(
  db: Database.Database,
  result: string | null,
  time: number,
  id: string | null,
  owner: string | null,
) {
  return completePreviewStatement(db).run({ result, time, id, owner });
}

const insertPreviewStatement = statement(
  "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,error,created_at,updated_at) VALUES(@id,@owner,@agent,@conversation,@input,@state,@id,@payload,@error,@time,@time)",
);
export function insertPreview(
  db: Database.Database,
  params: {
    id: string | null;
    owner: string | null;
    agent: string | null;
    conversation: string | null;
    input: string | null;
    state: string | null;
    payload: string | null;
    error: string | null;
    time: number;
  },
) {
  return insertPreviewStatement(db).run(params);
}

const getStatement = statement("SELECT * FROM runs WHERE id=?");

export function get(db: Database.Database, id: string | null) {
  const row = getStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.runs, row, "runs");
}

const activePreviewsStatement = statement(
  "SELECT * FROM runs WHERE owner_id=? AND state IN ('queued','running','awaiting_approval')",
);

export function activePreviews(db: Database.Database, owner: string | null) {
  return activePreviewsStatement(db)
    .all(owner)
    .map((row) => parseRecord(QueryRecords.runs, row, "runs"));
}

const steeredPreviewsStatement =
  statement(`SELECT * FROM runs WHERE owner_id=? AND state IN ('running','awaiting_approval')
            AND EXISTS(SELECT 1 FROM run_steering s WHERE s.owner_id=runs.owner_id AND s.run_id=runs.id AND s.state='pending')
            ORDER BY created_at LIMIT 10`);

export function steeredPreviews(db: Database.Database, owner: string | null) {
  return steeredPreviewsStatement(db)
    .all(owner)
    .map((row) => parseRecord(QueryRecords.runs, row, "runs"));
}

const ownedControlStatement = statement(
  "SELECT id,owner_id,state,worker_id,attention_dismissed_at FROM runs WHERE id=? AND owner_id=?",
);
const ownedControlRow = QueryRecords.runs.pick({
  id: true,
  owner_id: true,
  state: true,
  worker_id: true,
  attention_dismissed_at: true,
});
export function ownedControl(
  db: Database.Database,
  id: string | null,
  owner: string | null,
) {
  const row = ownedControlStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedControlRow, row, "runs");
}

const hasActiveStatement = statement(
  `SELECT 1 FROM runs WHERE owner_id=? AND state IN ${EXECUTING_RUN_STATES_SQL} LIMIT 1`,
);
const hasActiveRow = z.object({ "1": z.number() });
export function hasActive(db: Database.Database, owner: string | null) {
  const row = hasActiveStatement(db).get(owner);
  return row === undefined ? undefined : parseRecord(hasActiveRow, row, "runs");
}

const queuedInConversationStatement = statement(
  "SELECT * FROM runs WHERE owner_id=? AND conversation_id=? AND state='queued' ORDER BY COALESCE(queue_rank,created_at),rowid LIMIT 5",
);

export function queuedInConversation(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
) {
  return queuedInConversationStatement(db)
    .all(owner, conversation)
    .map((row) => parseRecord(QueryRecords.runs, row, "runs"));
}

const agentFileAccessStatement = statement(
  "SELECT 0 size FROM runs r JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id WHERE a.id=? AND r.id=? AND r.owner_id=?",
);
const agentFileAccessRow = z.object({ size: z.number() });
export function agentFileAccess(
  db: Database.Database,
  agent: string | null,
  id: string | null,
  owner: string | null,
) {
  const row = agentFileAccessStatement(db).get(agent, id, owner);
  return row === undefined
    ? undefined
    : parseRecord(agentFileAccessRow, row, "runs");
}

const existsOwnedStatement = statement(
  "SELECT 1 FROM runs WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(
  db: Database.Database,
  id: string | null,
  owner: string | null,
) {
  const row = existsOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "runs");
}

const outlineStatement = statement(
  "SELECT r.id,r.state,r.error,(SELECT count(*) FROM approvals a WHERE a.run_id=r.id AND a.owner_id=r.owner_id) approvals FROM runs r WHERE r.owner_id=? AND r.conversation_id=?",
);
const outlineRow = QueryRecords.runs
  .pick({ id: true, state: true, error: true })
  .extend({ approvals: z.number() });
export function outline(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
) {
  return outlineStatement(db)
    .all(owner, conversation)
    .map((row) => parseRecord(outlineRow, row, "runs"));
}

const rankQueuedStatement = statement(
  "UPDATE runs SET queue_rank=? WHERE id=? AND owner_id=? AND state='queued'",
);
export function rankQueued(
  db: Database.Database,
  rank: number,
  id: string | null,
  owner: string | null,
) {
  return rankQueuedStatement(db).run(rank, id, owner);
}

const editQueuedInputStatement = statement(
  "UPDATE runs SET input=?,updated_at=? WHERE id=? AND owner_id=? AND state='queued' AND worker_id IS NULL",
);
export function editQueuedInput(
  db: Database.Database,
  input: string | null,
  updated: number,
  id: string | null,
  owner: string | null,
) {
  return editQueuedInputStatement(db).run(input, updated, id, owner);
}

const hasIdempotencyStatement = statement(
  "SELECT 1 FROM runs WHERE owner_id=? AND idempotency_key=?",
);
const hasIdempotencyRow = z.object({ "1": z.number() });
export function hasIdempotency(
  db: Database.Database,
  owner: string | null,
  key: string | null,
) {
  const row = hasIdempotencyStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(hasIdempotencyRow, row, "runs");
}

const setResolvedModelStatement = statement(
  "UPDATE runs SET payload=json_set(payload,'$.resolvedModel',?) WHERE id=? AND owner_id=?",
);
export function setResolvedModel(
  db: Database.Database,
  model: string | null,
  id: string | null,
  owner: string | null,
) {
  return setResolvedModelStatement(db).run(model, id, owner);
}

const hasEarlierConversationRunStatement = statement(
  "SELECT 1 FROM runs WHERE conversation_id=? AND rowid<(SELECT rowid FROM runs WHERE id=?)",
);
const hasEarlierConversationRunRow = z.object({ "1": z.number() });
export function hasEarlierConversationRun(
  db: Database.Database,
  conversation: string | null,
  id: string | null,
) {
  const row = hasEarlierConversationRunStatement(db).get(conversation, id);
  return row === undefined
    ? undefined
    : parseRecord(hasEarlierConversationRunRow, row, "runs");
}

const orphanedNativeStatement = statement(
  "SELECT r.id,r.owner_id FROM runs r LEFT JOIN native_dispatch d ON d.run_id=r.id LEFT JOIN connections c ON c.id=json_extract(r.payload,'$.connectionId') WHERE (d.run_id IS NOT NULL OR json_extract(c.metadata,'$.loopHarness') IS NOT NULL) AND (r.state IN ('running','pausing','awaiting_approval') OR (r.state='queued' AND d.run_id IS NOT NULL))",
);
const orphanedNativeRow = QueryRecords.runs.pick({ id: true, owner_id: true });
export function orphanedNative(db: Database.Database) {
  return orphanedNativeStatement(db)
    .all()
    .map((row) => parseRecord(orphanedNativeRow, row, "runs"));
}

const interruptOrphanedNativeStatement = statement(
  "UPDATE runs SET state='interrupted',worker_id=NULL,error=?,updated_at=?,active_since=NULL WHERE id=?",
);
export function interruptOrphanedNative(
  db: Database.Database,
  error: string | null,
  updated: number,
  id: string | null,
) {
  return interruptOrphanedNativeStatement(db).run(error, updated, id);
}

const pendingCountStatement = statement(
  `SELECT count(*) n FROM runs WHERE owner_id=? AND state IN ${ACTIVE_RUN_STATES_SQL}`,
);
const pendingCountRow = z.object({ n: z.number() });
export function pendingCount(db: Database.Database, owner: string | null) {
  const row = pendingCountStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(pendingCountRow, row, "runs");
}

const insertQueuedStatement = statement(
  "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)",
);
export function insertQueued(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  agent: string | null,
  conversation: string | null,
  kind: string | null,
  input: string | null,
  key: string | null,
  payload: string | null,
  created: number,
  updated: number,
) {
  return insertQueuedStatement(db).run(
    id,
    owner,
    agent,
    conversation,
    kind,
    input,
    key,
    payload,
    created,
    updated,
  );
}

const claimLeaseStatement = statement(
  "UPDATE runs SET state=?,worker_id=?,heartbeat=?,updated_at=?,active_since=COALESCE(active_since,?) WHERE id=?",
);
export function claimLease(
  db: Database.Database,
  state: string | null,
  worker: string | null,
  heartbeat: number,
  updated: number,
  activeSince: number,
  id: string | null,
) {
  return claimLeaseStatement(db).run(
    state,
    worker,
    heartbeat,
    updated,
    activeSince,
    id,
  );
}

const deferUndispatchedStatement =
  statement(`UPDATE runs SET state='queued',worker_id=NULL,
    heartbeat=NULL,active_since=NULL,error=NULL,updated_at=? WHERE id=?
    AND state='running' AND worker_id=?
    AND NOT EXISTS(SELECT 1 FROM native_dispatch d WHERE d.run_id=runs.id)`);
export function deferUndispatched(
  db: Database.Database,
  updated: number,
  id: string | null,
  worker: string | null,
) {
  return deferUndispatchedStatement(db).run(updated, id, worker);
}

const ownedStateStatement = statement(
  "SELECT state FROM runs WHERE id=? AND owner_id=?",
);
const ownedStateRow = QueryRecords.runs.pick({ state: true });
export function ownedState(
  db: Database.Database,
  id: string | null,
  owner: string | null,
) {
  const row = ownedStateStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedStateRow, row, "runs");
}

const leasedStateStatement = statement(
  "SELECT state,result FROM runs WHERE id=? AND owner_id=? AND worker_id=?",
);
const leasedStateRow = QueryRecords.runs.pick({ state: true, result: true });
export function leasedState(
  db: Database.Database,
  id: string,
  owner: string,
  worker: string,
) {
  const row = leasedStateStatement(db).get(id, owner, worker);
  return row === undefined
    ? undefined
    : parseRecord(leasedStateRow, row, "runs");
}

const transitionStateStatement =
  statement(`UPDATE runs SET state=@state,updated_at=@time,
      active_ms=active_ms+CASE WHEN active_since IS NOT NULL AND @state NOT IN ('running','pausing')
        THEN max(0,(CASE WHEN @state='interrupted' THEN min(@time,COALESCE(heartbeat,@time)) ELSE @time END)-active_since) ELSE 0 END,
      active_since=CASE WHEN @state IN ('running','pausing') THEN active_since ELSE NULL END
      WHERE id=@id`);
export function transitionState(
  db: Database.Database,
  state: string | null,
  time: number,
  id: string | null,
) {
  return transitionStateStatement(db).run({ state, time, id });
}

const clearLeaseStatement = statement(
  "UPDATE runs SET worker_id=NULL,heartbeat=NULL WHERE id=?",
);
export function clearLease(db: Database.Database, id: string | null) {
  return clearLeaseStatement(db).run(id);
}

const staleIdentitiesStatement = statement(
  "SELECT * FROM runs WHERE state IN ('running','pausing') AND worker_id IS NOT NULL AND heartbeat<?",
);
const staleIdentitiesRow = RunIdentity;
export function staleIdentities(
  db: Database.Database,
  heartbeatBefore: number,
) {
  return staleIdentitiesStatement(db)
    .all(heartbeatBefore)
    .map((row) => parseRecord(staleIdentitiesRow, row, "runs"));
}

const markInvalidUnleasedStatement = statement(
  "UPDATE runs SET error=? WHERE id=? AND owner_id=? AND worker_id IS NULL AND state IN ('queued','running','pausing')",
);
export function markInvalidUnleased(
  db: Database.Database,
  error: string | null,
  id: string | null,
  owner: string | null,
) {
  return markInvalidUnleasedStatement(db).run(error, id, owner);
}

const cancellableChildrenStatement = statement(`
      SELECT r.id,r.owner_id FROM runs r WHERE r.owner_id=@owner AND r.id IN (
        SELECT child_run_id FROM delegations WHERE parent_run_id=@parent
        UNION SELECT rc.run_id FROM review_continuations rc WHERE rc.parent_run_id=@parent AND rc.owner_id=@owner
        UNION SELECT m.run_id FROM delegations d JOIN agent_mail m
          ON m.sender_run_id=d.child_run_id AND m.kind='result' AND m.owner_id=@owner
          JOIN runs result ON result.id=m.run_id AND result.owner_id=m.owner_id
          WHERE d.parent_run_id=@parent AND d.background=1 AND result.state='queued'
      )`);
const cancellableChildrenRow = RunIdentity;
export function cancellableChildren(
  db: Database.Database,
  owner: string | null,
  parent: string | null,
) {
  return cancellableChildrenStatement(db)
    .all({ owner, parent })
    .map((row) => parseRecord(cancellableChildrenRow, row, "runs"));
}

const dismissAttentionStatement = statement(
  "UPDATE runs SET attention_dismissed_at=? WHERE id=? AND owner_id=?",
);
export function dismissAttention(
  db: Database.Database,
  at: number,
  id: string | null,
  owner: string | null,
) {
  return dismissAttentionStatement(db).run(at, id, owner);
}

const signalStateStatement = statement(`SELECT r.state,
      CASE WHEN r.kind='agent' THEN json_extract(r.payload,'$.connectionId') END connection_id,c.status
      FROM runs r LEFT JOIN connections c
      ON c.id=json_extract(r.payload,'$.connectionId') AND c.owner_id=r.owner_id
      WHERE r.id=? AND r.owner_id=?`);
const signalStateRow = z.object({
  state: z.string(),
  connection_id: z.string().nullable(),
  status: z.string().nullable(),
});
export function signalState(
  db: Database.Database,
  id: string | null,
  owner: string | null,
) {
  const row = signalStateStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(signalStateRow, row, "runs");
}

const latestReviewStatement = statement(
  "SELECT json_extract(payload,'$.reviewId') reviewId FROM runs WHERE conversation_id=? AND owner_id=? ORDER BY rowid DESC LIMIT 1",
);
const latestReviewRow = z.object({ reviewId: z.string().nullable() });
export function latestReview(
  db: Database.Database,
  conversation: string | null,
  owner: string | null,
) {
  const row = latestReviewStatement(db).get(conversation, owner);
  return row === undefined
    ? undefined
    : parseRecord(latestReviewRow, row, "runs");
}

const traceExportStatement = statement(
  "SELECT id,input,state,error,conversation_id,created_at,updated_at FROM runs WHERE id=? AND owner_id=? AND agent_id=?",
);
const traceExportRow = QueryRecords.runs.pick({
  id: true,
  input: true,
  state: true,
  error: true,
  conversation_id: true,
  created_at: true,
  updated_at: true,
});
export function traceExport(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  agent: string | null,
) {
  const row = traceExportStatement(db).get(id, owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(traceExportRow, row, "runs");
}

const heartbeatLeaseStatement = statement(
  "UPDATE runs SET heartbeat=? WHERE id=? AND worker_id=?",
);
export function heartbeatLease(
  db: Database.Database,
  heartbeat: number,
  id: string | null,
  worker: string | null,
) {
  return heartbeatLeaseStatement(db).run(heartbeat, id, worker);
}

const leaseErrorStatement = statement(
  "UPDATE runs SET error=? WHERE id=? AND owner_id=? AND worker_id=? AND state IN ('running','pausing','awaiting_approval')",
);
export function leaseError(
  db: Database.Database,
  error: string | null,
  id: string | null,
  owner: string | null,
  worker: string | null,
) {
  return leaseErrorStatement(db).run(error, id, owner, worker);
}

// Graceful shutdown interrupts what a crash leaves recoverable. A run that is
// only awaiting_approval (durable checkpoint, no in-flight execution) lives on
// through a crash, so shutdown must not interrupt it either, or the two paths
// disagree (#355 S3). Native awaiting_approval runs are still interrupted so
// native session teardown owns the transition before its IO is terminated.
const workerShutdownIdentitiesStatement = statement(
  `SELECT r.id,r.owner_id FROM runs r
   LEFT JOIN native_dispatch d ON d.run_id=r.id
   LEFT JOIN connections c ON c.id=json_extract(r.payload,'$.connectionId') AND c.owner_id=r.owner_id
   WHERE r.worker_id=?
     AND (r.state IN ('running','pausing')
       OR (r.state='awaiting_approval' AND (d.run_id IS NOT NULL OR json_extract(c.metadata,'$.loopHarness') IS NOT NULL)))`,
);
const workerShutdownIdentitiesRow = RunIdentity;
export function workerShutdownIdentities(
  db: Database.Database,
  worker: string | null,
) {
  return workerShutdownIdentitiesStatement(db)
    .all(worker)
    .map((row) => parseRecord(workerShutdownIdentitiesRow, row, "runs"));
}

// Non-native runs stuck in awaiting_approval with only expired pending
// approvals (nothing actionable, nothing in flight) leave awaiting_approval so
// they stop holding the agent's queue and the Feed stops hiding the approval
// (#355 S2). Never runs the call: the caller only transitions the run.
const staleAwaitingApprovalStatement = statement(
  `SELECT r.id, r.owner_id FROM runs r
   LEFT JOIN native_dispatch d ON d.run_id = r.id
   WHERE r.state = 'awaiting_approval'
     AND d.run_id IS NULL
     AND EXISTS (SELECT 1 FROM approvals a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.state='pending' AND a.expires_at<?)
     AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.state='pending' AND a.expires_at>=?)
     AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.state IN ('approved','executing'))`,
);
const staleAwaitingApprovalRow = RunIdentity;
export function staleAwaitingApproval(db: Database.Database, time: number) {
  return staleAwaitingApprovalStatement(db)
    .all(time, time)
    .map((row) => parseRecord(staleAwaitingApprovalRow, row, "runs"));
}

// Single-run recheck used inside the same transaction as the expiry fail, so a
// concurrent approve that moved the run or refreshed its approvals is never
// overwritten. The strict `<`/`>=` boundary matches `decide`, which still
// accepts an approval exactly at `expires_at == now`.
const isStaleAwaitingApprovalStatement = statement(
  `SELECT 1 FROM runs r
   LEFT JOIN native_dispatch d ON d.run_id = r.id
   WHERE r.id=? AND r.owner_id=? AND r.state = 'awaiting_approval'
     AND d.run_id IS NULL
     AND EXISTS (SELECT 1 FROM approvals a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.state='pending' AND a.expires_at<?)
     AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.state='pending' AND a.expires_at>=?)
     AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id=r.id AND a.owner_id=r.owner_id AND a.state IN ('approved','executing'))`,
);
export function isStaleAwaitingApproval(
  db: Database.Database,
  time: number,
  id: string,
  owner: string,
) {
  const row = isStaleAwaitingApprovalStatement(db).get(id, owner, time, time);
  return !!(row !== undefined);
}

const activeImportStatement = statement(
  "SELECT * FROM runs WHERE owner_id=? AND kind='import' AND json_extract(payload,'$.importId')=? AND state IN ('queued','running','pausing','paused')",
);

export function activeImport(
  db: Database.Database,
  owner: string | null,
  importId: string | null,
) {
  const row = activeImportStatement(db).get(owner, importId);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.runs, row, "runs");
}

const importIdentitiesStatement = statement(
  "SELECT id,owner_id FROM runs WHERE owner_id=? AND kind='import' AND json_extract(payload,'$.importId')=?",
);
const importIdentitiesRow = RunIdentity;
export function importIdentities(
  db: Database.Database,
  owner: string | null,
  importId: string | null,
) {
  return importIdentitiesStatement(db)
    .all(owner, importId)
    .map((row) => parseRecord(importIdentitiesRow, row, "runs"));
}

const hasActiveForAgentStatement = statement(
  `SELECT 1 FROM runs WHERE owner_id=? AND agent_id=? AND state IN ${ACTIVE_RUN_STATES_SQL} LIMIT 1`,
);
const hasActiveForAgentRow = z.object({ "1": z.number() });
export function hasActiveForAgent(
  db: Database.Database,
  owner: string,
  agent: string,
) {
  const row = hasActiveForAgentStatement(db).get(owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(hasActiveForAgentRow, row, "runs");
}

const activeTeamConversationStatement = statement(
  `SELECT r.conversation_id FROM runs r JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id WHERE r.owner_id=? AND r.agent_id=? AND r.kind='agent' AND c.team_id=? AND r.state IN ${ACTIVE_RUN_STATES_SQL} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`,
);
const activeTeamConversationRow = z.object({ conversation_id: z.string() });
export function activeTeamConversation(
  db: Database.Database,
  owner: string,
  agent: string,
  team: string,
) {
  const row = activeTeamConversationStatement(db).get(owner, agent, team);
  return row === undefined
    ? undefined
    : parseRecord(activeTeamConversationRow, row, "runs");
}

const hasActiveAgentConversationStatement = statement(
  `SELECT 1 FROM runs WHERE owner_id=? AND agent_id=? AND conversation_id=? AND kind='agent' AND state IN ${ACTIVE_RUN_STATES_SQL}`,
);
const hasActiveAgentConversationRow = z.object({ "1": z.number() });
export function hasActiveAgentConversation(
  db: Database.Database,
  owner: string,
  agent: string,
  conversation: string | null,
) {
  const row = hasActiveAgentConversationStatement(db).get(
    owner,
    agent,
    conversation,
  );
  return row === undefined
    ? undefined
    : parseRecord(hasActiveAgentConversationRow, row, "runs");
}

const currentMailConversationStatement =
  statement(`SELECT r.conversation_id FROM runs r
         JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id AND c.agent_id=r.agent_id
         WHERE r.owner_id=? AND r.agent_id=? AND r.kind='agent' AND r.state='running'
           AND NOT EXISTS(SELECT 1 FROM agent_checkpoints p WHERE p.run_id=r.id AND p.stage='done')
         ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`);
const currentMailConversationRow = z.object({ conversation_id: z.string() });
export function currentMailConversation(
  db: Database.Database,
  owner: string,
  agent: string,
) {
  const row = currentMailConversationStatement(db).get(owner, agent);
  return row === undefined
    ? undefined
    : parseRecord(currentMailConversationRow, row, "runs");
}

const hasActiveConversationStatement = statement(
  `SELECT 1 FROM runs WHERE owner_id=? AND agent_id=? AND conversation_id=? AND state IN ${ACTIVE_RUN_STATES_SQL}`,
);
const hasActiveConversationRow = z.object({ "1": z.number() });
export function hasActiveConversation(
  db: Database.Database,
  owner: string,
  agent: string,
  conversation: string | null,
) {
  const row = hasActiveConversationStatement(db).get(
    owner,
    agent,
    conversation,
  );
  return row === undefined
    ? undefined
    : parseRecord(hasActiveConversationRow, row, "runs");
}

const hasOtherActiveStatement = statement(
  `SELECT 1 FROM runs WHERE owner_id=? AND agent_id=? AND id<>? AND state IN ${ACTIVE_RUN_STATES_SQL}`,
);
const hasOtherActiveRow = z.object({ "1": z.number() });
export function hasOtherActive(
  db: Database.Database,
  owner: string,
  agent: string,
  id: string,
) {
  const row = hasOtherActiveStatement(db).get(owner, agent, id);
  return row === undefined
    ? undefined
    : parseRecord(hasOtherActiveRow, row, "runs");
}

const queuePositionStatement =
  statement(`SELECT (SELECT count(*)+1 FROM runs older WHERE older.agent_id=r.agent_id
    AND older.state IN ${ACTIVE_RUN_STATES_SQL}
    AND (COALESCE(older.queue_rank,older.created_at)<COALESCE(r.queue_rank,r.created_at)
      OR (COALESCE(older.queue_rank,older.created_at)=COALESCE(r.queue_rank,r.created_at) AND older.rowid<r.rowid))) position
    FROM runs r WHERE r.id=? AND r.owner_id=?`);
const queuePositionRow = z.object({ position: z.number() });
export function queuePosition(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = queuePositionStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(queuePositionRow, row, "runs");
}

const queuePeersStatement =
  statement(`SELECT r.id,r.conversation_id,COALESCE(r.queue_rank,r.created_at) queue_key
  FROM runs r JOIN runs selected ON selected.id=@run AND selected.owner_id=@owner
  WHERE r.owner_id=@owner AND r.agent_id=selected.agent_id AND r.state='queued'
    AND (r.conversation_id=selected.conversation_id OR NOT ${perConversation("selected")} OR NOT ${perConversation("r")})
  ORDER BY COALESCE(r.queue_rank,r.created_at),r.rowid`);
const queuePeersRow = QueryRecords.runs
  .pick({ id: true, conversation_id: true })
  .extend({ queue_key: z.number() });
export function queuePeers(db: Database.Database, run: string, owner: string) {
  return queuePeersStatement(db)
    .all({ run, owner })
    .map((row) => parseRecord(queuePeersRow, row, "runs"));
}

const conversationUsageEventsStatement =
  statement(`SELECT e.run_id,e.type,e.payload FROM runs r CROSS JOIN events e INDEXED BY events_usage ON r.id=e.run_id AND r.owner_id=e.owner_id
      WHERE r.owner_id=? AND r.conversation_id=? AND e.type IN ('provider.receipt','native.usage') ORDER BY e.id`);
const conversationUsageEventsRow = z.object({
  run_id: z.string(),
  type: z.string(),
  payload: z.string(),
});
export function conversationUsageEvents(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  return conversationUsageEventsStatement(db)
    .all(owner, conversation)
    .map((row) => parseRecord(conversationUsageEventsRow, row, "runs"));
}

const hasActiveProviderStatement =
  statement(`SELECT 1 FROM runs r JOIN connections c
          ON c.id=json_extract(r.payload,'$.connectionId') AND c.owner_id=r.owner_id
          WHERE r.owner_id=? AND r.state IN ('running','pausing','awaiting_approval')
          AND json_extract(c.metadata,'$.loopHarness')=? LIMIT 1`);
const hasActiveProviderRow = z.object({ "1": z.number() });
export function hasActiveProvider(
  db: Database.Database,
  owner: string,
  name: string,
) {
  const row = hasActiveProviderStatement(db).get(owner, name);
  return row === undefined
    ? undefined
    : parseRecord(hasActiveProviderRow, row, "runs");
}

const activeSteeringStatement = statement(
  `SELECT r.*,${RUN_LIVE_INPUT_SQL("r")} live_input FROM runs r WHERE r.owner_id=@owner AND r.conversation_id=@conversation AND (@agent IS NULL OR r.agent_id=@agent) AND r.kind='agent' AND r.state IN ('running','awaiting_approval') AND NOT EXISTS(SELECT 1 FROM agent_checkpoints c WHERE c.run_id=r.id AND c.stage='done') ORDER BY r.created_at DESC LIMIT 1`,
);
const activeSteeringRow = QueryRecords.runs.extend({ live_input: z.number() });
export function activeSteering(
  db: Database.Database,
  owner: string,
  conversation: string,
  agent: string | null,
) {
  const row = activeSteeringStatement(db).get({ owner, conversation, agent });
  return row === undefined
    ? undefined
    : parseRecord(activeSteeringRow, row, "runs");
}

const webhookContextStatement =
  statement(`SELECT r.id,r.state,c.id conversation_id,c.title,c.project_id,c.team_id,
    a.id agent_id,a.name agent_name,COALESCE((SELECT substr(content,1,4000) FROM artifacts
    WHERE run_id=r.id AND owner_id=r.owner_id AND kind IN ('markdown','text','message')
    ORDER BY created_at DESC,id DESC LIMIT 1),substr(r.result,1,4000),'') preview
    FROM runs r LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
    LEFT JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id
    WHERE r.id=? AND r.owner_id=?`);
const webhookContextRow = QueryRecords.runs
  .pick({ id: true, state: true, conversation_id: true, agent_id: true })
  .extend({
    title: z.string().nullable(),
    project_id: z.string().nullable(),
    team_id: z.string().nullable(),
    agent_name: z.string().nullable(),
    preview: z.string(),
  });
export function webhookContext(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = webhookContextStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(webhookContextRow, row, "runs");
}

// An ineligible queued review only holds its own conversation. Also identify
// messages behind it, so they cannot become an indirect cross-conversation
// ordering barrier. Active leases and explicit pauses keep their usual rules.
const waitingForReview = (run: string) => `(${run}.state='queued' AND EXISTS (
 SELECT 1 FROM review_continuations rc JOIN runs waiting ON waiting.id=rc.run_id AND waiting.owner_id=rc.owner_id
 WHERE waiting.owner_id=${run}.owner_id AND waiting.agent_id=${run}.agent_id
   AND waiting.conversation_id=${run}.conversation_id AND waiting.state='queued'
   AND (COALESCE(waiting.queue_rank,waiting.created_at)<COALESCE(${run}.queue_rank,${run}.created_at)
     OR (COALESCE(waiting.queue_rank,waiting.created_at)=COALESCE(${run}.queue_rank,${run}.created_at) AND waiting.rowid<=${run}.rowid))
   AND NOT (${READY_REVIEW_CONTINUATION("waiting")})
))`;

const claimCandidatesStatement = statement(`WITH candidates AS (
 SELECT runs.rowid AS queue_order, runs.*,
   ${waitingForReview("runs")} AS waiting_review,
   (json_extract(runs.payload,'$.mailId') IS NOT NULL OR EXISTS(SELECT 1 FROM review_continuations rc WHERE rc.run_id=runs.id) OR EXISTS(SELECT 1 FROM agent_mail m WHERE (m.run_id=runs.id AND m.steering_id IS NULL) OR m.requeued_run_id=runs.id)) AS is_mail,
   EXISTS(SELECT 1 FROM connections c WHERE c.id=json_extract(runs.payload,'$.connectionId')
     AND c.owner_id=runs.owner_id AND ${NATIVE_CONNECTION_SQL}) AS per_conversation
 FROM runs
 WHERE runs.state IN ${ACTIVE_RUN_STATES_SQL}
)
SELECT r.* FROM candidates r WHERE
 ${READY_REVIEW_CONTINUATION("r")} AND
 ((r.state='queued' AND r.worker_id IS NULL AND NOT EXISTS(SELECT 1 FROM native_dispatch d WHERE d.run_id=r.id)) OR (r.state IN ('running','pausing') AND r.worker_id IS NULL AND EXISTS(SELECT 1 FROM delegations d WHERE d.parent_run_id=r.id AND d.background=0)))
 AND NOT EXISTS(SELECT 1 FROM candidates busy WHERE busy.owner_id=r.owner_id AND busy.agent_id=r.agent_id AND (r.is_mail OR busy.is_mail OR busy.conversation_id=r.conversation_id OR NOT r.per_conversation OR NOT busy.per_conversation) AND busy.id<>r.id AND ((busy.state IN ('running','pausing','awaiting_approval') AND busy.worker_id IS NOT NULL) OR ((r.is_mail OR busy.is_mail) AND busy.state IN ('running','pausing','paused','awaiting_approval'))))
 AND NOT EXISTS(SELECT 1 FROM candidates older WHERE older.owner_id=r.owner_id AND older.agent_id=r.agent_id AND (r.is_mail OR older.conversation_id=r.conversation_id OR NOT r.per_conversation OR (NOT older.is_mail AND NOT older.per_conversation)) AND older.state IN ${ACTIVE_RUN_STATES_SQL} AND (COALESCE(older.queue_rank,older.created_at)<COALESCE(r.queue_rank,r.created_at) OR (COALESCE(older.queue_rank,older.created_at)=COALESCE(r.queue_rank,r.created_at) AND older.queue_order<r.queue_order))
   AND (older.conversation_id=r.conversation_id OR NOT older.waiting_review)
   AND NOT (EXISTS(SELECT 1 FROM delegations delegated WHERE delegated.child_run_id=r.id AND delegated.background=0) AND (older.state='queued' OR (older.state='running' AND older.worker_id IS NULL AND EXISTS(SELECT 1 FROM delegations waiting WHERE waiting.parent_run_id=older.id AND waiting.background=0)))))
 AND NOT EXISTS(SELECT 1 FROM delegations d JOIN runs child ON child.id=d.child_run_id WHERE d.parent_run_id=r.id AND d.background=0 AND child.state IN ${ACTIVE_RUN_DISPLAY_STATES_SQL})
 ORDER BY COALESCE(r.queue_rank,r.created_at),r.queue_order`);
export function claimCandidates(
  db: Database.Database,
  reject: (run: z.infer<typeof RunIdentity>, error: InvalidRow) => void,
): Run[] {
  return claimCandidatesStatement(db)
    .all()
    .flatMap((value) => {
      try {
        return [parseRun(value)];
      } catch (error) {
        if (!(error instanceof InvalidRow)) throw error;
        reject(RunIdentity.parse(value), error);
        return [];
      }
    });
}

const attentionStatements = statementVariants();
const attentionRow = QueryRecords.runs.extend({
  state: QueryRecords.runs.shape.state.or(z.literal("waiting_children")),
  queue_position: z.number(),
  preview: z.string().nullable(),
});
export function attention(
  db: Database.Database,
  owner: string,
  teams: string[],
  active: boolean,
) {
  const filters = teams.length
    ? " AND json_extract(r.payload,'$.teamId') IN (" +
      teams.map(() => "?").join(",") +
      ")"
    : "";
  const states = active
    ? ` AND r.state NOT IN ('completed','cancelled') AND r.attention_dismissed_at IS NULL
        AND (r.state NOT IN ('failed','interrupted') OR NOT EXISTS (
          SELECT 1 FROM runs newer WHERE newer.owner_id=r.owner_id
            AND newer.conversation_id=r.conversation_id
            AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.rowid>r.rowid))
        ))`
    : "";
  const order = active
    ? `CASE WHEN r.state IN ('running','pausing') AND r.worker_id IS NOT NULL THEN 0 WHEN r.state IN ${ACTIVE_RUN_STATES_SQL} THEN 1 ELSE 2 END,`
    : "";

  return attentionStatements(
    `SELECT r.*,${publicRunStateSql("r")} AS state,(SELECT count(*)+1 FROM runs older WHERE older.agent_id=r.agent_id AND older.state IN ${ACTIVE_RUN_DISPLAY_STATES_SQL} AND (COALESCE(older.queue_rank,older.created_at)<COALESCE(r.queue_rank,r.created_at) OR (COALESCE(older.queue_rank,older.created_at)=COALESCE(r.queue_rank,r.created_at) AND older.rowid<r.rowid))) queue_position,(SELECT substr(m.content,1,320) FROM messages m WHERE m.run_id=r.id AND m.role='assistant' ORDER BY m.rowid DESC LIMIT 1) preview FROM runs r WHERE r.owner_id=?${filters}${states} ORDER BY ${order}r.created_at DESC,r.rowid DESC LIMIT 200`,
    db,
  )
    .all(owner, ...teams)
    .map((row) => parseRecord(attentionRow, row, "runs"));
}

const noticeRow = QueryRecords.runs.pick({
  id: true,
  owner_id: true,
  agent_id: true,
  conversation_id: true,
  input: true,
  state: true,
  result: true,
  error: true,
});
export function ownedNotice(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined ? undefined : parseRecord(noticeRow, row, "runs");
}

const doneInConversationStatement = statement(
  `SELECT 1 FROM runs WHERE id=? AND owner_id=? AND conversation_id=? AND state IN ${TERMINAL_RUN_STATES_SQL}`,
);
const doneInConversationRow = z.object({ "1": z.number() });
export function doneInConversation(
  db: Database.Database,
  id: string,
  owner: string,
  conversation: string,
) {
  const row = doneInConversationStatement(db).get(id, owner, conversation);
  return row === undefined
    ? undefined
    : parseRecord(doneInConversationRow, row, "runs");
}

const awayStatements = statementVariants();
const awayRow = z.object({
  conversation_id: z.string(),
  title: z.string(),
  agent_name: z.string().nullable(),
  run_id: z.string(),
  state: z.string(),
  updated_at: z.number(),
});
export function awaySummary(
  db: Database.Database,
  owner: string,
  since: number,
  now: () => number,
) {
  const summary = (condition: string, params: unknown[] = []) =>
    awayStatements(
      `SELECT r.conversation_id,c.title,a.name agent_name,r.id run_id,${publicRunStateSql("r")} state,r.updated_at
        FROM runs r JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
        LEFT JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id
        WHERE r.owner_id=? AND (${condition})
        ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 20`,
      db,
    )
      .all(owner, ...params)
      .map((row) => parseRecord(awayRow, row, "runs"));
  return {
    completed: summary("r.state='completed' AND r.updated_at>?", [since]),
    needs: summary(
      `r.attention_dismissed_at IS NULL AND (r.state IN ('awaiting_approval','paused')
      OR EXISTS(SELECT 1 FROM approvals ap WHERE ap.run_id=r.id AND ap.owner_id=r.owner_id AND ap.state='pending' AND ap.expires_at>?)
      OR (r.state IN ('failed','interrupted') AND NOT EXISTS(SELECT 1 FROM runs newer WHERE newer.owner_id=r.owner_id AND newer.conversation_id=r.conversation_id AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.rowid>r.rowid)))))`,
      [now()],
    ),
    failed: summary("r.state IN ('failed','interrupted') AND r.updated_at>?", [
      since,
    ]),
  };
}

const checkoutStatements = statementVariants();
export function overlappingCheckoutRuns(
  db: Database.Database,
  owner: string,
  project: string,
  id: string,
  observedAt: number,
  startedAt: number,
  states: readonly string[],
) {
  const ACTIVE_STATES = states;
  return checkoutStatements(
    `SELECT r.id FROM runs r JOIN companion_sessions s ON s.conversation_id=r.conversation_id
             WHERE r.owner_id=? AND s.project=? AND r.id<>? AND r.state<>'queued' AND r.created_at<=?
               AND (r.updated_at>=? OR r.state IN (${ACTIVE_STATES.map(() => "?").join(",")}))
             ORDER BY r.created_at`,
    db,
  )
    .all(owner, project, id, observedAt, startedAt, ...states)
    .map((row) =>
      parseRecord(QueryRecords.runs.pick({ id: true }), row, "runs"),
    );
}

const projectSummaryStatement = statement(
  `WITH RECURSIVE ${FOLDER_PROJECT} ${`SELECT fp.project_id,max(r.updated_at) last,
      sum(r.state IN ('running','pausing')) working,
      sum(r.attention_dismissed_at IS NULL AND (r.state IN ('awaiting_approval','paused') OR r.state IN ('failed','interrupted'))) needs
    FROM runs r LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
    JOIN folder_project fp ON fp.id IS COALESCE(c.project_id,json_extract(r.payload,'$.folderId'))
    WHERE r.owner_id=@owner AND (r.conversation_id IS NULL OR c.id IS NOT NULL) GROUP BY fp.project_id`}`,
);
const projectSummaryRow = z.object({
  project_id: z.string(),
  last: z.number(),
  working: z.number(),
  needs: z.number(),
});
export function projectSummaries(db: Database.Database, owner: string) {
  return projectSummaryStatement(db)
    .all({ owner })
    .map((row) => parseRecord(projectSummaryRow, row, "runs"));
}

const conversationWorkingStatement = statement(
  `SELECT EXISTS(SELECT 1 FROM runs WHERE owner_id=? AND conversation_id=? AND state IN ${ACTIVE_RUN_STATES_SQL}) working`,
);
const conversationWorkingRow = z.object({ working: z.number() });
export function conversationWorking(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  return (
    parseRecord(
      conversationWorkingRow,
      conversationWorkingStatement(db).get(owner, conversation),
      "runs",
    ).working !== 0
  );
}

const executingCountStatement = statement(
  `SELECT count(*) n FROM runs WHERE owner_id=? AND state IN ${EXECUTING_RUN_STATES_SQL}`,
);
export function executingCount(db: Database.Database, owner: string) {
  return parseRecord(
    pendingCountRow,
    executingCountStatement(db).get(owner),
    "runs",
  );
}
