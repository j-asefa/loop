import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const preferencesStatement = statement(
  "SELECT s.endpoint,COALESCE(p.needs_you,1) needsYou,\n    COALESCE(p.completed,1) completed,COALESCE(p.reminders,1) reminders,COALESCE(p.social,1) social\n    FROM push_subscriptions s LEFT JOIN push_preferences p ON p.subscription_id=s.id WHERE s.owner_id=?",
);
const preferencesRow = z.object({
  endpoint: z.string(),
  needsYou: z.number(),
  completed: z.number(),
  reminders: z.number(),
  social: z.number(),
});
export function preferences(db: Database.Database, owner: string) {
  return preferencesStatement(db)
    .all(owner)
    .map((row) => parseRecord(preferencesRow, row, "push_subscriptions"));
}

const endpointsStatement = statement(
  "SELECT endpoint FROM push_subscriptions WHERE owner_id=?",
);
const endpointsRow = QueryRecords.push_subscriptions.pick({ endpoint: true });
export function endpoints(db: Database.Database, owner: string) {
  return endpointsStatement(db)
    .all(owner)
    .map((row) => parseRecord(endpointsRow, row, "push_subscriptions"));
}

const byEndpointStatement = statement(
  "SELECT id,owner_id FROM push_subscriptions WHERE endpoint=?",
);
const byEndpointRow = QueryRecords.push_subscriptions.pick({
  id: true,
  owner_id: true,
});
export function byEndpoint(db: Database.Database, endpoint: string) {
  const row = byEndpointStatement(db).get(endpoint);
  return row === undefined
    ? undefined
    : parseRecord(byEndpointRow, row, "push_subscriptions");
}

const countStatement = statement(
  "SELECT count(*) n FROM push_subscriptions WHERE owner_id=?",
);
const countRow = z.object({ n: z.number() });
export function count(db: Database.Database, owner: string) {
  const row = countStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(countRow, row, "push_subscriptions");
}

const upsertStatement = statement(
  "INSERT INTO push_subscriptions VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription",
);
export function upsert(
  db: Database.Database,
  id: string,
  owner: string,
  endpoint: string,
  subscription: string,
  created: number,
) {
  return upsertStatement(db).run(id, owner, endpoint, subscription, created);
}

const ownedEndpointStatement = statement(
  "SELECT id FROM push_subscriptions WHERE endpoint=? AND owner_id=?",
);
const ownedEndpointRow = QueryRecords.push_subscriptions.pick({ id: true });
export function ownedEndpoint(
  db: Database.Database,
  endpoint: string,
  owner: string,
) {
  const row = ownedEndpointStatement(db).get(endpoint, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedEndpointRow, row, "push_subscriptions");
}

const removeEndpointStatement = statement(
  "DELETE FROM push_subscriptions WHERE endpoint=? AND owner_id=?",
);
export function removeEndpoint(
  db: Database.Database,
  endpoint: string,
  owner: string,
) {
  return removeEndpointStatement(db).run(endpoint, owner);
}

const removeStatement = statement("DELETE FROM push_subscriptions WHERE id=?");
export function remove(db: Database.Database, id: string) {
  return removeStatement(db).run(id);
}

// Remove only the subscription whose stored sealed value still matches the
// delivery that the 404/410 rejected, in one atomic statement: a browser that
// re-subscribed the same endpoint in between keeps its newer subscription.
const removeIfSubscriptionStatement = statement(
  "DELETE FROM push_subscriptions WHERE id=? AND subscription=?",
);
export function removeIfSubscription(
  db: Database.Database,
  id: string,
  subscription: string,
) {
  return removeIfSubscriptionStatement(db).run(id, subscription);
}
