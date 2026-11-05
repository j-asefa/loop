import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { InvalidRow, parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
export const LIVE_INPUT_HARNESSES = new Set(["codex", "claude", "pi", "muse"]);

// Callers qualify metadata through the connections alias c.
export const NATIVE_CONNECTION_SQL =
  "json_extract(c.metadata,'$.loopHarness') IS NOT NULL";

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
export function owned(db: Database.Database, id: string | null, owner: string) {
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

const ownerStatusStatement = statement(
  "SELECT owner_id,status FROM connections WHERE id=?",
);
const ownerStatusRow = QueryRecords.connections.pick({
  owner_id: true,
  status: true,
});
export function ownerStatus(db: Database.Database, id: string) {
  const row = ownerStatusStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(ownerStatusRow, row, "connections");
}

const resolvedNativeModelStatement = statement(
  "SELECT json_extract(value,'$.resolvedModel') model FROM connections,json_each(connections.models) WHERE connections.id=? AND connections.owner_id=? AND json_valid(connections.models) AND json_extract(value,'$.id')='native-default'",
);
const resolvedNativeModelRow = z.object({ model: z.string().nullable() });
export function resolvedNativeModel(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = resolvedNativeModelStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(resolvedNativeModelRow, row, "connections");
}

const registerNativeStatement = statement(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,?,'connected',?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,status='connected',models=excluded.models,metadata=excluded.metadata",
);
export function registerNative(
  db: Database.Database,
  id: string,
  owner: string,
  provider: string,
  label: string,
  secret: string,
  models: string,
  metadata: string,
  created: number,
) {
  return registerNativeStatement(db).run(
    id,
    owner,
    provider,
    label,
    secret,
    models,
    metadata,
    created,
  );
}

const registerDisconnectedNativeStatement = statement(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,'','disconnected','[]',?,?) ON CONFLICT(id) DO UPDATE SET status='disconnected',models='[]' WHERE owner_id=excluded.owner_id",
);
export function registerDisconnectedNative(
  db: Database.Database,
  id: string,
  owner: string,
  provider: string,
  label: string,
  metadata: string,
  created: number,
) {
  return registerDisconnectedNativeStatement(db).run(
    id,
    owner,
    provider,
    label,
    metadata,
    created,
  );
}

const statusModelsStatement = statement(
  "SELECT status,models FROM connections WHERE id=? AND owner_id=?",
);
const statusModelsRow = QueryRecords.connections.pick({
  status: true,
  models: true,
});
export function statusModels(db: Database.Database, id: string, owner: string) {
  const row = statusModelsStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(statusModelsRow, row, "connections");
}

const statusMetadataStatement = statement(
  "SELECT status,metadata FROM connections WHERE id=? AND owner_id=?",
);
const statusMetadataRow = QueryRecords.connections.pick({
  status: true,
  metadata: true,
});
export function statusMetadata(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = statusMetadataStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(statusMetadataRow, row, "connections");
}

const needsSignInStatement = statement(
  "UPDATE connections SET status='needs_sign_in' WHERE id=? AND owner_id=? AND status<>'disconnected'",
);
export function needsSignIn(db: Database.Database, id: string, owner: string) {
  return needsSignInStatement(db).run(id, owner);
}

const readModelsStatement = statement(
  "SELECT models FROM connections WHERE id=? AND owner_id=?",
);
export function readModels(db: Database.Database, id: string, owner: string) {
  const row = readModelsStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(
        QueryRecords.connections.pick({ models: true }),
        row,
        "connections",
      );
}

const idStatement = statement("SELECT id FROM connections WHERE id=?");
const idRow = QueryRecords.connections.pick({ id: true });
export function id(db: Database.Database, id: string) {
  const row = idStatement(db).get(id);
  return row === undefined ? undefined : parseRecord(idRow, row, "connections");
}

const metadataStatement = statement(
  "SELECT metadata FROM connections WHERE id=? AND owner_id=?",
);
const metadataRow = QueryRecords.connections.pick({ metadata: true });
export function metadata(db: Database.Database, id: string, owner: string) {
  const row = metadataStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(metadataRow, row, "connections");
}

const setResolvedNativeModelStatement = statement(
  "UPDATE connections SET models=(SELECT json_group_array(CASE WHEN json_extract(value,'$.id')='native-default' THEN json_set(value,'$.resolvedModel',?) ELSE json(value) END) FROM json_each(connections.models)) WHERE id=? AND owner_id=? AND json_valid(models)",
);
export function setResolvedNativeModel(
  db: Database.Database,
  model: string,
  id: string | undefined,
  owner: string,
) {
  return setResolvedNativeModelStatement(db).run(model, id, owner);
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

const statusStatement = statement(
  "SELECT status FROM connections WHERE id=? AND owner_id=?",
);
const statusRow = QueryRecords.connections.pick({ status: true });
export function status(
  db: Database.Database,
  id: string | null | undefined,
  owner: string,
) {
  const row = statusStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(statusRow, row, "connections");
}

const workerMetadataStatement = statement(
  "SELECT metadata FROM connections WHERE id=? AND owner_id=?",
);
const workerMetadataRow = QueryRecords.connections.pick({ metadata: true });
export function workerMetadata(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = workerMetadataStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(workerMetadataRow, row, "connections");
}

const subscriptionNeedsReconnectStatement = statement(
  "UPDATE connections SET status='needs_reconnect' WHERE id=? AND owner_id=? AND status='connected'",
);

export function subscriptionNeedsReconnect(
  db: Database.Database,
  id: string,
  owner: string,
) {
  return subscriptionNeedsReconnectStatement(db).run(id, owner);
}

const signingInStatement = statement(
  "UPDATE connections SET status='signing_in' WHERE id=?",
);

export function signingIn(db: Database.Database, id: string) {
  return signingInStatement(db).run(id);
}

const resetSigningInStatement = statement(
  "UPDATE connections SET status='needs_sign_in' WHERE id=? AND status='signing_in'",
);

export function resetSigningIn(db: Database.Database, id: string) {
  return resetSigningInStatement(db).run(id);
}

const subscriptionConnectedStatement = statement(
  "UPDATE connections SET models=?,status='connected',metadata=? WHERE id=? AND status<>'disconnected'",
);

export function subscriptionConnected(
  db: Database.Database,
  models: string,
  metadata: string,
  id: string,
) {
  return subscriptionConnectedStatement(db).run(models, metadata, id);
}

const subscriptionNeedsSignInStatement = statement(
  "UPDATE connections SET status='needs_sign_in' WHERE id=?",
);

export function subscriptionNeedsSignIn(db: Database.Database, id: string) {
  return subscriptionNeedsSignInStatement(db).run(id);
}

const connectedExistsStatement = statement(
  "SELECT 1 FROM connections WHERE id=? AND owner_id=? AND status='connected'",
);

const connectedExistsRow = z.object({ "1": z.number() });

export function connectedExists(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = connectedExistsStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(connectedExistsRow, row, "connections");
}

const cardModelStatement = statement(
  "SELECT id,provider,models FROM connections WHERE owner_id=? AND id=?",
);
const cardModelRow = QueryRecords.connections.pick({
  id: true,
  provider: true,
  models: true,
});
export function cardModel(db: Database.Database, owner: string, id: string) {
  const row = cardModelStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(cardModelRow, row, "connections");
}

const anyStatement = statement("SELECT 1 FROM connections LIMIT 1");
const anyRow = z.object({ "1": z.number() });
export function any(db: Database.Database) {
  const row = anyStatement(db).get();
  return row === undefined
    ? undefined
    : parseRecord(anyRow, row, "connections");
}

const insertPreviewStatement = statement(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Preview simulator',?,'connected',?,'{\"preview\":true}',?)",
);
export function insertPreview(
  db: Database.Database,
  id: string,
  owner: string,
  secret: string,
  models: string,
  created: number,
) {
  return insertPreviewStatement(db).run(id, owner, secret, models, created);
}
