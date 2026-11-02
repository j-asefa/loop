import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
export const LIVE_INPUT_HARNESSES = new Set(["codex", "claude", "pi", "muse"]);

// Callers qualify metadata through the connections alias c.
export const NATIVE_CONNECTION_SQL =
  "json_extract(c.metadata,'$.loop55Harness') IS NOT NULL";

const ownerConnectionStatement = statement(
  "SELECT * FROM connections WHERE owner_id=? AND id=?",
);
const ownerConnectionRow = QueryRecords.connections;
export function ownerConnection(
  db: Database.Database,
  owner: string,
  connection: string | null,
) {
  const row = ownerConnectionStatement(db).get(owner, connection);
  return row === undefined
    ? undefined
    : parseRecord(ownerConnectionRow, row, "connections");
}

const existsOwnedStatement = statement(
  "SELECT 1 FROM connections WHERE id=? AND owner_id=?",
);
const existsOwnedRow = z.object({ "1": z.number() });
export function existsOwned(
  db: Database.Database,
  connection: string,
  owner: string,
) {
  const row = existsOwnedStatement(db).get(connection, owner);
  return row === undefined
    ? undefined
    : parseRecord(existsOwnedRow, row, "connections");
}

const ownedStatement = statement(
  "SELECT * FROM connections WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.connections, row, "connections");
}

const publicCatalogStatement = statement(
  "SELECT id,provider,label,status,models,metadata FROM connections WHERE owner_id=?",
);
const publicCatalogRow = QueryRecords.connections.pick({
  id: true,
  provider: true,
  label: true,
  status: true,
  models: true,
  metadata: true,
});
export function publicCatalog(db: Database.Database, owner: string) {
  return publicCatalogStatement(db)
    .all(owner)
    .map((row) => parseRecord(publicCatalogRow, row, "connections"));
}

const insertStatement = statement(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  provider: string,
  label: string,
  secret: string,
  status: string,
  models: string,
  metadata: string,
  created: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    provider,
    label,
    secret,
    status,
    models,
    metadata,
    created,
  );
}

const connectedModelsStatement = statement(
  "UPDATE connections SET models=?,status='connected' WHERE id=?",
);
export function connectedModels(
  db: Database.Database,
  models: string,
  id: string,
) {
  return connectedModelsStatement(db).run(models, id);
}

const needsReconnectStatement = statement(
  "UPDATE connections SET status='needs_reconnect' WHERE id=?",
);
export function needsReconnect(db: Database.Database, id: string) {
  return needsReconnectStatement(db).run(id);
}

const modelsStatement = statement("UPDATE connections SET models=? WHERE id=?");
export function models(db: Database.Database, models: string, id: string) {
  return modelsStatement(db).run(models, id);
}

const reconnectStatement = statement(
  "UPDATE connections SET secret=?,models=?,status='connected' WHERE id=?",
);
export function reconnect(
  db: Database.Database,
  secret: string,
  models: string,
  id: string,
) {
  return reconnectStatement(db).run(secret, models, id);
}

const disconnectStatement = statement(
  "UPDATE connections SET secret='',status='disconnected',metadata=CASE WHEN json_valid(metadata) THEN json_remove(metadata,'$.retiredDirectRuntime','$.nativeRecoveryRequired') ELSE metadata END WHERE id=? AND owner_id=?",
);
export function disconnect(db: Database.Database, id: string, owner: string) {
  return disconnectStatement(db).run(id, owner);
}

const nativeOwnedStatement = statement(
  `SELECT 1 FROM connections c WHERE c.id=? AND c.owner_id=? AND ${NATIVE_CONNECTION_SQL}`,
);
const nativeOwnedRow = z.object({ "1": z.number() });
export function nativeOwned(
  db: Database.Database,
  id: string | null,
  owner: string,
) {
  const row = nativeOwnedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(nativeOwnedRow, row, "connections");
}
// Revocation must remain available for damaged display/storage fields. Validate
// ownership here; parseConnectionControl validates routing inside its caller's
// recovery boundary before any external logout.
const ownedForRevocationRow = QueryRecords.connections
  .pick({ id: true, owner_id: true })
  .extend({ provider: z.unknown(), metadata: z.unknown() });
export function ownedForRevocation(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedForRevocationRow, row, "connections");
}
