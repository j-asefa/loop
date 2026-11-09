import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const stoppedSubscribersStatement = statement(
  "SELECT id FROM webhook_subscriptions\n    WHERE owner_id=? AND state IN ('active','failed') AND EXISTS\n    (SELECT 1 FROM json_each(kinds) WHERE value='run.stopped')",
);
const stoppedSubscribersRow = QueryRecords.webhook_subscriptions.pick({
  id: true,
});
export function stoppedSubscribers(db: Database.Database, owner: string) {
  return stoppedSubscribersStatement(db)
    .all(owner)
    .map((row) =>
      parseRecord(stoppedSubscribersRow, row, "webhook_subscriptions"),
    );
}

const ownedStatement = statement(
  "SELECT * FROM webhook_subscriptions WHERE id=? AND owner_id=?",
);
const ownedRow = QueryRecords.webhook_subscriptions;
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "webhook_subscriptions");
}

const forOwnerStatement = statement(
  "SELECT * FROM webhook_subscriptions WHERE owner_id=? ORDER BY created_at DESC,id DESC",
);
const forOwnerRow = QueryRecords.webhook_subscriptions;
export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) => parseRecord(forOwnerRow, row, "webhook_subscriptions"));
}

const byIdStatement = statement(
  "SELECT * FROM webhook_subscriptions WHERE id=?",
);
const byIdRow = QueryRecords.webhook_subscriptions;
export function byId(db: Database.Database, id: string) {
  const row = byIdStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(byIdRow, row, "webhook_subscriptions");
}

const creationStatement = statement(
  "SELECT owner_id,creation_digest FROM webhook_subscriptions WHERE id=?",
);
const creationRow = QueryRecords.webhook_subscriptions.pick({
  owner_id: true,
  creation_digest: true,
});
export function creation(db: Database.Database, id: string) {
  const row = creationStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(creationRow, row, "webhook_subscriptions");
}

const activeCountStatement = statement(
  "SELECT count(*) n FROM webhook_subscriptions WHERE owner_id=? AND state<>'revoked'",
);
const activeCountRow = z.object({ n: z.number() });
export function activeCount(db: Database.Database, owner: string) {
  const row = activeCountStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(activeCountRow, row, "webhook_subscriptions");
}

const insertStatement = statement(
  "INSERT INTO webhook_subscriptions(id,owner_id,url,secret_sealed,creation_digest,kinds,local,state,created_at)\n      VALUES(?,?,?,?,?,?,?,'pending_activation',?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  url: string,
  secret: string,
  digest: string,
  kinds: string,
  local: number,
  created: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    url,
    secret,
    digest,
    kinds,
    local,
    created,
  );
}

const setKindsStatement = statement(
  "UPDATE webhook_subscriptions SET kinds=? WHERE id=?",
);
export function setKinds(db: Database.Database, kinds: string, id: string) {
  return setKindsStatement(db).run(kinds, id);
}

const revokeStatement = statement(
  "UPDATE webhook_subscriptions SET state='revoked',revoked_at=COALESCE(revoked_at,?) WHERE id=?",
);
export function revoke(db: Database.Database, time: number, id: string) {
  return revokeStatement(db).run(time, id);
}

const activateStatement = statement(
  "UPDATE webhook_subscriptions SET state='active',failed_at=NULL WHERE id=?",
);
export function activate(db: Database.Database, id: string) {
  return activateStatement(db).run(id);
}

const failStatement = statement(
  "UPDATE webhook_subscriptions SET state=CASE WHEN state='active' AND @kind='run.stopped' THEN 'failed' ELSE state END,\n    failed_at=CASE WHEN state IN ('active','failed') AND @kind='run.stopped' THEN @time ELSE failed_at END,last_error=@error,last_status=@status,last_attempts=@attempts WHERE id=@id AND state<>'revoked'",
);
export function fail(
  db: Database.Database,
  kind: string,
  time: number,
  error: string,
  status: number | null,
  attempts: number,
  id: string,
) {
  return failStatement(db).run({ kind, time, error, status, attempts, id });
}

const settleStatement = statement(
  "UPDATE webhook_subscriptions SET last_status=@status,last_error=@error,last_attempts=@attempts,last_delivered_at=CASE WHEN @accepted THEN @time ELSE last_delivered_at END,\n      state=CASE WHEN @accepted AND @purpose='activation' AND state='pending_activation' THEN 'active' ELSE state END,\n      activated_at=CASE WHEN @accepted AND @purpose='activation' AND state='pending_activation' THEN @activatedAt ELSE activated_at END WHERE id=@id",
);
export function settle(
  db: Database.Database,
  status: number | null,
  error: string | null,
  attempts: number,
  accepted: number,
  time: number,
  purpose: string | null,
  activatedAt: number,
  id: string,
) {
  return settleStatement(db).run({
    status,
    error,
    attempts,
    accepted,
    time,
    purpose,
    activatedAt,
    id,
  });
}
