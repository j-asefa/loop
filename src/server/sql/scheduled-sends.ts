import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const summaryStatement = statement(
  "SELECT COALESCE(sum(state='failed'),0) failed,COALESCE(sum(state='scheduled'),0) pending FROM scheduled_sends WHERE owner_id=?",
);
const summaryRow = z.object({ failed: z.number(), pending: z.number() });
export function summary(db: Database.Database, owner: string) {
  const row = summaryStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(summaryRow, row, "scheduled_sends");
}

const byIdempotencyStatement = statement(
  "SELECT * FROM scheduled_sends WHERE owner_id=? AND idempotency_key=?",
);

export function byIdempotency(
  db: Database.Database,
  owner: string,
  key: string,
) {
  const row = byIdempotencyStatement(db).get(owner, key);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.scheduled_sends, row, "scheduled_sends");
}

const pendingCountStatement = statement(
  "SELECT count(*) n FROM scheduled_sends WHERE owner_id=? AND state='scheduled'",
);
const pendingCountRow = z.object({ n: z.number() });
export function pendingCount(db: Database.Database, owner: string) {
  const row = pendingCountStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(pendingCountRow, row, "scheduled_sends");
}

const insertStatement = statement(
  "INSERT INTO scheduled_sends(id,owner_id,agent_id,conversation_id,folder_id,folder_chosen,input,attachment_ids,reply_to_message_id,reply_excerpt,idempotency_key,send_at,state,created_at)\n        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  agent: string,
  conversation: string | null,
  folder: string | null,
  chosen: number,
  input: string,
  attachments: string,
  reply: string | null,
  excerpt: string | null,
  key: string,
  send: number,
  created: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    agent,
    conversation,
    folder,
    chosen,
    input,
    attachments,
    reply,
    excerpt,
    key,
    send,
    created,
  );
}

const ownedStatement = statement(
  "SELECT * FROM scheduled_sends WHERE id=? AND owner_id=?",
);

export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.scheduled_sends, row, "scheduled_sends");
}

const cancelStatement = statement(
  "UPDATE scheduled_sends SET state='cancelled' WHERE id=? AND owner_id=? AND state IN ('scheduled','failed')",
);
export function cancel(db: Database.Database, id: string, owner: string) {
  return cancelStatement(db).run(id, owner);
}

const rescheduleStatement = statement(
  "UPDATE scheduled_sends SET input=?,send_at=?,state='scheduled',error=NULL WHERE id=? AND owner_id=? AND state IN ('scheduled','failed')",
);
export function reschedule(
  db: Database.Database,
  input: string,
  send: number,
  id: string,
  owner: string,
) {
  return rescheduleStatement(db).run(input, send, id, owner);
}

const submittedStatement = statement(
  "UPDATE scheduled_sends SET state='submitted',run_id=?,error=NULL WHERE id=?",
);
export function submitted(db: Database.Database, run: string, id: string) {
  return submittedStatement(db).run(run, id);
}

const setErrorStatement = statement(
  "UPDATE scheduled_sends SET error=? WHERE id=?",
);
export function setError(db: Database.Database, error: string, id: string) {
  return setErrorStatement(db).run(error, id);
}

const dueIdsStatement = statement(
  "SELECT id FROM scheduled_sends WHERE state='scheduled' AND send_at<=? ORDER BY send_at,rowid LIMIT 20",
);
const dueIdsRow = QueryRecords.scheduled_sends.pick({ id: true });
export function dueIds(db: Database.Database, time: number) {
  return dueIdsStatement(db)
    .all(time)
    .map((row) => parseRecord(dueIdsRow, row, "scheduled_sends"));
}

const scheduledStatement = statement(
  "SELECT * FROM scheduled_sends WHERE id=? AND state='scheduled'",
);

export function scheduled(db: Database.Database, id: string) {
  const row = scheduledStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.scheduled_sends, row, "scheduled_sends");
}

const failStatement = statement(
  "UPDATE scheduled_sends SET state='failed',error=? WHERE id=?",
);
export function fail(db: Database.Database, error: string, id: string) {
  return failStatement(db).run(error, id);
}

const select = `SELECT s.*,a.name agent_name,a.provider,c.title conversation_title,f.name folder_name
        FROM scheduled_sends s
        LEFT JOIN agents a ON a.id=s.agent_id AND a.owner_id=s.owner_id
        LEFT JOIN conversations c ON c.id=s.conversation_id AND c.owner_id=s.owner_id
        LEFT JOIN folders f ON f.id=COALESCE(s.folder_id,c.project_id) AND f.owner_id=s.owner_id
        WHERE s.owner_id=@owner AND (@conversation IS NULL OR s.conversation_id=@conversation)`;

const failedPageStatement = statement(`${select} AND s.state='failed'
        AND (@at IS NULL OR s.send_at<@at OR (s.send_at=@at AND (s.created_at<@created OR (s.created_at=@created AND s.id<@id))))
        ORDER BY s.send_at DESC,s.created_at DESC,s.id DESC LIMIT @limit`);
const failedPageRow = QueryRecords.scheduled_sends.extend({
  agent_name: z.string().nullable(),
  provider: z.string().nullable(),
  conversation_title: z.string().nullable(),
  folder_name: z.string().nullable(),
});
export function failedPage(
  db: Database.Database,
  params: {
    owner: string;
    conversation: string | null;
    at: number | null;
    created: number | null;
    id: string | null;
    limit: number;
  },
) {
  return failedPageStatement(db)
    .all(params)
    .map((row) => parseRecord(failedPageRow, row, "scheduled-sends"));
}

const pendingPageStatement = statement(
  `${select} AND s.state='scheduled' ORDER BY s.send_at,s.created_at`,
);
const pendingPageRow = QueryRecords.scheduled_sends.extend({
  agent_name: z.string().nullable(),
  provider: z.string().nullable(),
  conversation_title: z.string().nullable(),
  folder_name: z.string().nullable(),
});
export function pendingPage(
  db: Database.Database,
  params: { owner: string; conversation: string | null },
) {
  return pendingPageStatement(db)
    .all(params)
    .map((row) => parseRecord(pendingPageRow, row, "scheduled-sends"));
}
