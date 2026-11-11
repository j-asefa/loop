import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const enqueueStoppedStatement = statement(
  "INSERT INTO webhook_deliveries(id,subscription_id,event_id,kind,payload,created_at,available_at)\n      VALUES(@id,@subscription,@event,'run.stopped',@payload,@created,@created) ON CONFLICT(subscription_id,event_id) DO NOTHING",
);
export function enqueueStopped(
  db: Database.Database,
  id: string,
  subscription: string,
  event: number,
  payload: string,
  created: number,
) {
  return enqueueStoppedStatement(db).run({
    id,
    subscription,
    event,
    payload,
    created,
  });
}

const byIdStatement = statement("SELECT * FROM webhook_deliveries WHERE id=?");

export function byId(db: Database.Database, id: string) {
  const row = byIdStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.webhook_deliveries, row, "webhook_deliveries");
}

const activationStatement = statement(
  "SELECT * FROM webhook_deliveries WHERE subscription_id=? AND purpose='activation'",
);

export function activation(db: Database.Database, subscription: string) {
  const row = activationStatement(db).get(subscription);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.webhook_deliveries, row, "webhook_deliveries");
}

const historyStatement = statement(
  "SELECT * FROM webhook_deliveries WHERE subscription_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
);

export function history(db: Database.Database, subscription: string) {
  return historyStatement(db)
    .all(subscription)
    .map((row) =>
      parseRecord(QueryRecords.webhook_deliveries, row, "webhook_deliveries"),
    );
}

const insertControlStatement = statement(
  "INSERT INTO webhook_deliveries(id,subscription_id,kind,purpose,request_id,payload,created_at,available_at)\n    VALUES(@id,@subscription,'control',@purpose,@request,@payload,@created,@created)",
);
export function insertControl(
  db: Database.Database,
  id: string,
  subscription: string,
  purpose: string,
  request: string,
  payload: string,
  created: number,
) {
  return insertControlStatement(db).run({
    id,
    subscription,
    purpose,
    request,
    payload,
    created,
  });
}

const revokeSubscriptionStatement = statement(
  "UPDATE webhook_deliveries SET exhausted=1,\n      outcome=CASE WHEN dispatch_started_at IS NULL THEN 'cancelled' ELSE\n        CASE WHEN outcome='sending' THEN 'uncertain' ELSE outcome END END,\n      last_error=CASE WHEN dispatch_started_at IS NULL THEN 'Revoked before dispatch' ELSE last_error END\n      WHERE subscription_id=? AND delivered_at IS NULL",
);
export function revokeSubscription(
  db: Database.Database,
  subscription: string,
) {
  return revokeSubscriptionStatement(db).run(subscription);
}

const leasedStatement = statement(
  "SELECT 1 FROM webhook_deliveries WHERE subscription_id=? AND leased_until>? LIMIT 1",
);
const leasedRow = z.object({ "1": z.number() });
export function leased(
  db: Database.Database,
  subscription: string,
  time: number,
) {
  const row = leasedStatement(db).get(subscription, time);
  return row === undefined
    ? undefined
    : parseRecord(leasedRow, row, "webhook_deliveries");
}

const resetStatement = statement(
  "UPDATE webhook_deliveries SET attempts=0,available_at=?,leased_until=NULL,lease_id=NULL,exhausted=0\n      WHERE subscription_id=? AND delivered_at IS NULL AND (?<>'pending_activation' OR purpose='activation')",
);
export function reset(
  db: Database.Database,
  time: number,
  subscription: string,
  state: string,
) {
  return resetStatement(db).run(time, subscription, state);
}

const exhaustStatement = statement(
  "UPDATE webhook_deliveries SET exhausted=1,last_error=?,last_status=?,lease_id=NULL,leased_until=NULL WHERE id=?",
);
export function exhaust(
  db: Database.Database,
  error: string,
  status: number | null,
  id: string,
) {
  return exhaustStatement(db).run(error, status, id);
}

const dueStatement = statement(
  "SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id\n      WHERE d.delivered_at IS NULL AND d.exhausted=0 AND d.available_at<=@time AND (d.leased_until IS NULL OR d.leased_until<=@leaseTime)\n      AND (@only IS NULL OR d.id=@only) AND (s.state='active' OR (s.state='pending_activation' AND d.purpose='activation') OR (s.state='failed' AND d.purpose='test'))\n      ORDER BY d.available_at,d.id LIMIT 4",
);

export function due(
  db: Database.Database,
  time: number,
  leaseTime: number,
  only: string | null,
) {
  return dueStatement(db)
    .all({ time, leaseTime, only })
    .map((row) =>
      parseRecord(QueryRecords.webhook_deliveries, row, "webhook_deliveries"),
    );
}

const uncertainStatement = statement(
  "UPDATE webhook_deliveries SET outcome='uncertain',last_status=NULL,last_error='Worker stopped before confirming delivery' WHERE id=?",
);
export function uncertain(db: Database.Database, id: string) {
  return uncertainStatement(db).run(id);
}

const leaseStatement = statement(
  "UPDATE webhook_deliveries SET lease_id=?,leased_until=? WHERE id=?",
);
export function lease(
  db: Database.Database,
  lease: string,
  until: number,
  id: string,
) {
  return leaseStatement(db).run(lease, until, id);
}

const releaseStatement = statement(
  "UPDATE webhook_deliveries SET lease_id=NULL,leased_until=NULL WHERE id=? AND lease_id=?",
);
export function release(db: Database.Database, id: string, lease: string) {
  return releaseStatement(db).run(id, lease);
}

const dispatchStatement = statement(
  "UPDATE webhook_deliveries SET attempts=attempts+1,dispatch_started_at=?,outcome='sending' WHERE id=? AND lease_id=?",
);
export function dispatch(
  db: Database.Database,
  time: number,
  id: string,
  lease: string,
) {
  return dispatchStatement(db).run(time, id, lease);
}

const settleStatement = statement(
  "UPDATE webhook_deliveries SET attempts=?,leased_until=NULL,lease_id=NULL,delivered_at=?,last_status=?,last_error=?,outcome=?,exhausted=?,available_at=? WHERE id=? AND lease_id=?",
);
export function settle(
  db: Database.Database,
  attempts: number,
  delivered: number | null,
  status: number | null,
  error: string | null,
  outcome: string,
  exhausted: number,
  available: number,
  id: string,
  lease: string,
) {
  return settleStatement(db).run(
    attempts,
    delivered,
    status,
    error,
    outcome,
    exhausted,
    available,
    id,
    lease,
  );
}
