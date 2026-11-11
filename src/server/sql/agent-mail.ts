import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord, parseRun, InvalidRow, type Run } from "../row-schemas.js";
import { RunIdentity } from "./runs.js";
import { statement } from "./statement.js";

// Message and receipt readers do not consume private retry bookkeeping.
// Validate it only at queue/delivery boundaries and when scheduling retries.
const messageRow = QueryRecords.agent_mail.omit({
  attempts: true,
  retry_at: true,
});

const byIdempotencyStatement = statement(
  "SELECT * FROM agent_mail WHERE owner_id=? AND idempotency_key=?",
);
const byIdempotencyRow = messageRow;
export function byIdempotency(
  db: Database.Database,
  owner: string,
  key: string,
) {
  const row = byIdempotencyStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(byIdempotencyRow, row, "agent_mail");
}

const heldCountStatement = statement(
  "SELECT count(*) n FROM agent_mail WHERE thread_id=? AND state='held'",
);
const heldCountRow = z.object({ n: z.number() });
export function heldCount(db: Database.Database, thread: string) {
  return parseRecord(
    heldCountRow,
    heldCountStatement(db).get(thread),
    "agent_mail",
  ).n;
}

const holdStatement = statement(
  "UPDATE agent_mail SET state='held' WHERE id=?",
);
export function hold(db: Database.Database, id: string) {
  return holdStatement(db).run(id);
}

const receivedFromPeerStatement = statement(`
      WITH peer_threads AS (
        SELECT t.id,t.resumed_order FROM agent_threads t
        JOIN fleet_mail_threads f ON f.thread_id=t.id AND f.owner_id=t.owner_id
        WHERE t.owner_id=@owner AND f.peer_id=@peer AND f.local_agent_id=@recipient
          AND f.fleet_id=@fleet AND f.local_grant_id=@localGrant AND f.peer_grant_id=@peerGrant
      )
      SELECT count(*) n FROM agent_mail m
      JOIN fleet_mail_records r ON r.mail_id=m.id AND r.owner_id=m.owner_id
      WHERE m.owner_id=@owner AND m.thread_id IN (SELECT id FROM peer_threads)
        AND r.peer_id=@peer AND r.direction='incoming' AND m.recipient_agent_id=@recipient
        AND m.kind='message' AND m.state IN ('sent','pending') AND m.id<>@mailId
        AND m.created_at>@since AND m.rowid>COALESCE((SELECT max(resumed_order) FROM peer_threads),0)
    `);
const receivedFromPeerRow = z.object({ n: z.number() });
export function receivedFromPeer(
  db: Database.Database,
  bindings: {
    owner: string;
    peer: string;
    recipient: string;
    fleet: string;
    localGrant: string;
    peerGrant: string;
    mailId: string;
    since: number;
  },
) {
  const row = receivedFromPeerStatement(db).get(bindings);
  return row === undefined
    ? undefined
    : parseRecord(receivedFromPeerRow, row, "agent_mail");
}

const threadMessageCountStatement = statement(
  "SELECT count(*) n FROM agent_mail WHERE thread_id=? AND kind='message' AND rowid>? AND id<>?",
);
const threadMessageCountRow = z.object({ n: z.number() });
export function threadMessageCount(
  db: Database.Database,
  thread: string,
  after: number,
  excluding: string,
) {
  return parseRecord(
    threadMessageCountRow,
    threadMessageCountStatement(db).get(thread, after, excluding),
    "agent_mail",
  ).n;
}

const pairMessageCountStatement = statement(
  "SELECT count(*) n FROM agent_mail WHERE owner_id=@owner AND kind='message' AND state IN ('sent','pending') AND id<>@excluding AND created_at>@since AND rowid>@after AND ((sender_agent_id=@sender AND recipient_agent_id=@recipient) OR (sender_agent_id=@recipient AND recipient_agent_id=@sender))",
);
const pairMessageCountRow = z.object({ n: z.number() });
export function pairMessageCount(
  db: Database.Database,
  owner: string,
  excluding: string,
  since: number,
  after: number,
  sender: string,
  recipient: string,
) {
  return parseRecord(
    pairMessageCountRow,
    pairMessageCountStatement(db).get({
      owner,
      excluding,
      since,
      after,
      sender,
      recipient,
    }),
    "agent_mail",
  ).n;
}

const hasEarlierPendingStatement = statement(
  "SELECT 1 FROM agent_mail WHERE thread_id=? AND state='pending' AND rowid<(SELECT rowid FROM agent_mail WHERE id=?)",
);
const hasEarlierPendingRow = z.object({ "1": z.number() });
export function hasEarlierPending(
  db: Database.Database,
  thread: string,
  id: string,
) {
  const row = hasEarlierPendingStatement(db).get(thread, id);
  return row === undefined
    ? undefined
    : parseRecord(hasEarlierPendingRow, row, "agent_mail");
}

const markSentStatement = statement(
  "UPDATE agent_mail SET state='sent',error=NULL,delivery=?,run_id=?,steering_id=?,recipient_conversation_id=?,sent_at=? WHERE id=?",
);
export function markSent(
  db: Database.Database,
  delivery: string,
  run: string,
  steering: unknown,
  conversation: string | null,
  sent: number,
  id: string,
) {
  return markSentStatement(db).run(
    delivery,
    run,
    steering,
    conversation,
    sent,
    id,
  );
}

const refuseStatement = statement(
  "UPDATE agent_mail SET state='refused',error=? WHERE id=?",
);
export function refuse(db: Database.Database, error: string, id: string) {
  return refuseStatement(db).run(error, id);
}

const attemptsStatement = statement(
  "SELECT attempts FROM agent_mail WHERE id=?",
);
const attemptsRow = QueryRecords.agent_mail.pick({ attempts: true });
export function attempts(db: Database.Database, id: string) {
  const row = attemptsStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(attemptsRow, row, "agent_mail");
}

const scheduleRetryStatement = statement(
  "UPDATE agent_mail SET state='pending',error=?,attempts=?,retry_at=? WHERE id=?",
);
export function scheduleRetry(
  db: Database.Database,
  error: string,
  attempts: number,
  retry: number,
  id: string,
) {
  return scheduleRetryStatement(db).run(error, attempts, retry, id);
}

const insertPendingStatement = statement(
  "INSERT INTO agent_mail(id,owner_id,team_id,thread_id,kind,sender_agent_id,sender_run_id,sender_conversation_id,recipient_agent_id,recipient_conversation_id,body,file_ids,interrupt,idempotency_key,request,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)",
);
export function insertPending(
  db: Database.Database,
  id: string,
  owner: string,
  team: string | null,
  thread: string,
  kind: string,
  sender: string,
  senderRun: string | null,
  senderConversation: string | null,
  recipient: string,
  recipientConversation: string | null,
  body: string,
  files: string,
  interrupt: number,
  key: string,
  request: string,
  created: number,
) {
  return insertPendingStatement(db).run(
    id,
    owner,
    team,
    thread,
    kind,
    sender,
    senderRun,
    senderConversation,
    recipient,
    recipientConversation,
    body,
    files,
    interrupt,
    key,
    request,
    created,
  );
}

const senderRunMessageCountStatement = statement(
  "SELECT count(*) n FROM agent_mail WHERE sender_run_id=? AND kind='message'",
);
const senderRunMessageCountRow = z.object({ n: z.number() });
export function senderRunMessageCount(db: Database.Database, run: string) {
  return parseRecord(
    senderRunMessageCountRow,
    senderRunMessageCountStatement(db).get(run),
    "agent_mail",
  ).n;
}

const pendingCountStatement = statement(
  "SELECT count(*) n FROM agent_mail WHERE owner_id=? AND state='pending'",
);
const pendingCountRow = z.object({ n: z.number() });
export function pendingCount(db: Database.Database, owner: string) {
  return parseRecord(
    pendingCountRow,
    pendingCountStatement(db).get(owner),
    "agent_mail",
  ).n;
}

const ownedSenderRunMessageCountStatement = statement(
  "SELECT count(*) n FROM agent_mail WHERE owner_id=? AND sender_run_id=? AND kind='message'",
);
const ownedSenderRunMessageCountRow = z.object({ n: z.number() });
export function ownedSenderRunMessageCount(
  db: Database.Database,
  owner: string,
  run: string,
) {
  return parseRecord(
    ownedSenderRunMessageCountRow,
    ownedSenderRunMessageCountStatement(db).get(owner, run),
    "agent_mail",
  ).n;
}

const incomingStatement =
  statement(`SELECT m.* FROM agent_mail m JOIN fleet_mail_records f ON f.mail_id=m.id AND f.owner_id=m.owner_id
        WHERE m.owner_id=? AND m.id=? AND m.thread_id=? AND f.direction='incoming'`);
const incomingRow = messageRow;
export function incoming(
  db: Database.Database,
  owner: string,
  id: string,
  thread: string,
) {
  const row = incomingStatement(db).get(owner, id, thread);
  return row === undefined
    ? undefined
    : parseRecord(incomingRow, row, "agent_mail");
}

const firstInThreadStatement = statement(
  "SELECT * FROM agent_mail WHERE thread_id=? ORDER BY created_at,rowid LIMIT 1",
);
const firstInThreadRow = messageRow;
export function firstInThread(db: Database.Database, thread: string) {
  const row = firstInThreadStatement(db).get(thread);
  return row === undefined
    ? undefined
    : parseRecord(firstInThreadRow, row, "agent_mail");
}

const recentInThreadStatement = statement(
  "SELECT * FROM (SELECT *,rowid r FROM agent_mail WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30) ORDER BY created_at,r",
);
const recentInThreadRow = messageRow.extend({ r: z.number() });
export function recentInThread(db: Database.Database, thread: string) {
  return recentInThreadStatement(db)
    .all(thread)
    .map((row) => parseRecord(recentInThreadRow, row, "agent_mail"));
}

const latestInThreadStatement = statement(
  "SELECT * FROM agent_mail WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
);
const latestInThreadRow = messageRow;
export function latestInThread(db: Database.Database, thread: string) {
  const row = latestInThreadStatement(db).get(thread);
  return row === undefined
    ? undefined
    : parseRecord(latestInThreadRow, row, "agent_mail");
}

const markRequeuedStatement = statement(
  "UPDATE agent_mail SET requeued_run_id=?,delivery='queued',recipient_conversation_id=? WHERE id=?",
);
export function markRequeued(
  db: Database.Database,
  run: string,
  conversation: string | null,
  id: string,
) {
  return markRequeuedStatement(db).run(run, conversation, id);
}

const strandedStatement =
  statement(`SELECT m.* FROM agent_mail m JOIN run_steering s ON s.id=m.steering_id
       WHERE m.steering_id IS NOT NULL AND m.requeued_run_id IS NULL AND m.state='sent' AND s.state='failed' AND s.error=?
       ORDER BY m.created_at LIMIT 200`);
const strandedRow = QueryRecords.agent_mail;
const strandedIdentityRow = QueryRecords.agent_mail.pick({ id: true });
export function stranded(
  db: Database.Database,
  error: string,
  reject: (id: string, error: InvalidRow) => void,
) {
  return strandedStatement(db)
    .all(error)
    .flatMap((row) => {
      try {
        return [parseRecord(strandedRow, row, "agent_mail")];
      } catch (error) {
        if (!(error instanceof InvalidRow)) throw error;
        reject(parseRecord(strandedIdentityRow, row, "agent_mail").id, error);
        return [];
      }
    });
}

const pendingHeadsStatement = statement(
  "SELECT m.id FROM agent_mail m WHERE m.state='pending' AND m.retry_at<=? AND NOT EXISTS(SELECT 1 FROM fleet_mail_outbox f WHERE f.owner_id=m.owner_id AND f.message_id=m.id) AND NOT EXISTS(SELECT 1 FROM agent_mail earlier WHERE earlier.thread_id=m.thread_id AND earlier.state='pending' AND earlier.rowid<m.rowid) ORDER BY m.retry_at,m.created_at,m.rowid LIMIT 200",
);
const pendingHeadsRow = QueryRecords.agent_mail.pick({ id: true });
export function pendingHeads(db: Database.Database, time: number) {
  return pendingHeadsStatement(db)
    .all(time)
    .map((row) => parseRecord(pendingHeadsRow, row, "agent_mail"));
}

const dueStatement = statement(
  "SELECT * FROM agent_mail WHERE id=? AND state='pending' AND retry_at<=?",
);
const dueRow = QueryRecords.agent_mail;
export function due(db: Database.Database, id: string, time: number) {
  const row = dueStatement(db).get(id, time);
  return row === undefined ? undefined : parseRecord(dueRow, row, "agent_mail");
}

const heldInThreadStatement = statement(
  "SELECT * FROM agent_mail WHERE thread_id=? AND state='held' ORDER BY created_at,rowid",
);
const heldInThreadRow = messageRow;
export function heldInThread(db: Database.Database, thread: string) {
  return heldInThreadStatement(db)
    .all(thread)
    .map((row) => parseRecord(heldInThreadRow, row, "agent_mail"));
}

const forQueuedRunStatement = statement(
  "SELECT m.*,t.scope FROM agent_mail m JOIN agent_threads t ON t.id=m.thread_id WHERE (m.run_id=@run AND m.steering_id IS NULL) OR m.requeued_run_id=@run",
);
const forQueuedRunRow = QueryRecords.agent_mail.extend({ scope: z.string() });
export function forQueuedRun(db: Database.Database, run: string) {
  const row = forQueuedRunStatement(db).get({ run });
  return row === undefined
    ? undefined
    : parseRecord(forQueuedRunRow, row, "agent_mail");
}

const hasQueuedRunStatement = statement(
  "SELECT 1 FROM agent_mail WHERE (run_id=@run AND steering_id IS NULL) OR requeued_run_id=@run",
);
const hasQueuedRunRow = z.object({ "1": z.number() });
export function hasQueuedRun(db: Database.Database, run: string) {
  const row = hasQueuedRunStatement(db).get({ run });
  return row === undefined
    ? undefined
    : parseRecord(hasQueuedRunRow, row, "agent_mail");
}

const outgoingStatement =
  statement(`SELECT m.* FROM agent_mail m JOIN fleet_mail_records r ON r.mail_id=m.id
      WHERE m.owner_id=? AND m.id=? AND r.owner_id=m.owner_id AND r.direction='outgoing'`);
const outgoingRow = messageRow;
export function outgoing(db: Database.Database, owner: string, id: string) {
  const row = outgoingStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(outgoingRow, row, "agent_mail");
}

const releaseOutgoingStatement = statement(
  "UPDATE agent_mail SET state='pending',error=NULL WHERE id=?",
);
export function releaseOutgoing(db: Database.Database, id: string) {
  return releaseOutgoingStatement(db).run(id);
}

const ownedStatement = statement(
  "SELECT * FROM agent_mail WHERE owner_id=? AND id=?",
);
const ownedRow = messageRow;
export function owned(db: Database.Database, owner: string, id: string) {
  const row = ownedStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "agent_mail");
}

const outgoingProjectionStatement =
  statement(`SELECT m.*,r.projection_pending FROM agent_mail m JOIN fleet_mail_records r ON r.mail_id=m.id
        WHERE m.owner_id=? AND m.id=? AND r.owner_id=m.owner_id AND r.direction='outgoing'`);
const outgoingProjectionRow = QueryRecords.agent_mail
  .pick({
    interrupt: true,
    thread_id: true,
    recipient_agent_id: true,
  })
  .extend({ projection_pending: z.number() });
export function outgoingProjection(
  db: Database.Database,
  owner: string,
  id: string,
) {
  const row = outgoingProjectionStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(outgoingProjectionRow, row, "agent_mail");
}

const projectRefusedStatement =
  statement(`UPDATE agent_mail SET state='refused',error=? WHERE owner_id=? AND id=?
          AND (state IS NOT 'refused' OR error IS NOT ?)`);
export function projectRefused(
  db: Database.Database,
  error: string,
  owner: string,
  id: string,
  previousError: string,
) {
  return projectRefusedStatement(db).run(error, owner, id, previousError);
}

const projectAcceptedStatement =
  statement(`UPDATE agent_mail SET state='sent',error=NULL,recipient_conversation_id=?,sent_at=COALESCE(sent_at,?)
          WHERE owner_id=? AND id=? AND (state IS NOT 'sent' OR error IS NOT NULL
            OR recipient_conversation_id IS NOT ? OR sent_at IS NULL)`);
export function projectAccepted(
  db: Database.Database,
  conversation: string | null,
  sent: number,
  owner: string,
  id: string,
  previousConversation: string | null,
) {
  return projectAcceptedStatement(db).run(
    conversation,
    sent,
    owner,
    id,
    previousConversation,
  );
}

const setOwnedErrorStatement = statement(
  "UPDATE agent_mail SET error=? WHERE owner_id=? AND id=?",
);
export function setOwnedError(
  db: Database.Database,
  error: string,
  owner: string,
  id: string,
) {
  return setOwnedErrorStatement(db).run(error, owner, id);
}

const ownedLatestInThreadStatement = statement(
  "SELECT * FROM agent_mail WHERE owner_id=? AND thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
);
const ownedLatestInThreadRow = messageRow;
export function ownedLatestInThread(
  db: Database.Database,
  owner: string,
  thread: string,
) {
  const row = ownedLatestInThreadStatement(db).get(owner, thread);
  return row === undefined
    ? undefined
    : parseRecord(ownedLatestInThreadRow, row, "agent_mail");
}

const ownedThreadCountStatement = statement(
  "SELECT count(*) n FROM agent_mail WHERE owner_id=? AND thread_id=?",
);
const ownedThreadCountRow = z.object({ n: z.number() });
export function ownedThreadCount(
  db: Database.Database,
  owner: string,
  thread: string,
) {
  const row = ownedThreadCountStatement(db).get(owner, thread);
  return row === undefined
    ? undefined
    : parseRecord(ownedThreadCountRow, row, "agent_mail");
}

const ownedThreadPageStatement = statement(
  "SELECT *,rowid ordinal FROM agent_mail WHERE owner_id=@owner AND thread_id=@thread AND (@before IS NULL OR (created_at,rowid)<(@before,@ordinal)) ORDER BY created_at DESC,rowid DESC LIMIT @limit",
);
const ownedThreadPageRow = messageRow.extend({
  ordinal: z.number(),
});
export function ownedThreadPage(
  db: Database.Database,
  owner: string,
  thread: string,
  before: number | null,
  ordinal: number | null,
  limit: number,
) {
  return ownedThreadPageStatement(db)
    .all({ owner, thread, before, ordinal, limit })
    .map((row) => parseRecord(ownedThreadPageRow, row, "agent_mail"));
}

const queuedRunsStatement =
  statement(`SELECT DISTINCT r.* FROM agent_mail m JOIN runs r ON ((m.run_id=r.id AND m.steering_id IS NULL) OR m.requeued_run_id=r.id) AND m.owner_id=r.owner_id
         WHERE r.state='queued' AND r.worker_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM native_dispatch d WHERE d.run_id=r.id)`);
// Reject malformed execution data individually, before queue availability checks.
export function queuedRuns(
  db: Database.Database,
  reject: (run: z.infer<typeof RunIdentity>, error: InvalidRow) => void,
): Run[] {
  return queuedRunsStatement(db)
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

const participantsStatement = statement(
  "WITH participants AS (\n          SELECT sender_agent_id id FROM agent_mail WHERE owner_id=@owner AND thread_id=@thread\n          UNION SELECT recipient_agent_id FROM agent_mail WHERE owner_id=@owner AND thread_id=@thread\n        ) SELECT p.id,a.name FROM participants p\n        LEFT JOIN agents a ON a.id=p.id AND a.owner_id=@owner\n        WHERE a.id IS NOT NULL OR EXISTS (\n          SELECT 1 FROM fleet_mail_threads f WHERE f.owner_id=@owner AND f.thread_id=@thread\n          AND p.id='peer:'||f.peer_id||':'||f.remote_agent_id\n        ) ORDER BY a.name,p.id",
);
const participantsRow = z.object({
  id: z.string(),
  name: z.string().nullable(),
});
export function participants(
  db: Database.Database,
  key: { owner: string; thread: string },
) {
  return participantsStatement(db)
    .all(key)
    .map((row) => parseRecord(participantsRow, row, "agent_mail"));
}
