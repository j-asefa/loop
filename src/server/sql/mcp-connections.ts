import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT * FROM mcp_connections WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.mcp_connections, row, "mcp_connections");
}

const byCatalogStatement = statement(
  "SELECT * FROM mcp_connections WHERE owner_id=? AND json_extract(metadata,'$.catalogId')=? ORDER BY created_at LIMIT 1",
);

export function byCatalog(
  db: Database.Database,
  owner: string,
  catalog: string,
) {
  const row = byCatalogStatement(db).get(owner, catalog);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.mcp_connections, row, "mcp_connections");
}

const uncataloguedUrlStatement = statement(
  "SELECT * FROM mcp_connections WHERE owner_id=? AND rtrim(url,'/')=rtrim(?,'/') AND json_extract(metadata,'$.catalogId') IS NULL ORDER BY CASE status WHEN 'connected' THEN 0 ELSE 1 END, created_at LIMIT 1",
);

export function uncataloguedUrl(
  db: Database.Database,
  owner: string,
  url: string,
) {
  const row = uncataloguedUrlStatement(db).get(owner, url);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.mcp_connections, row, "mcp_connections");
}

const setMetadataStatement = statement(
  "UPDATE mcp_connections SET metadata=? WHERE id=?",
);
export function setMetadata(
  db: Database.Database,
  metadata: string,
  id: string,
) {
  return setMetadataStatement(db).run(metadata, id);
}

const catalogNeedsAuthStatement = statement(
  "UPDATE mcp_connections SET secret=?,status='needs_auth',metadata=? WHERE id=?",
);
export function catalogNeedsAuth(
  db: Database.Database,
  secret: string,
  metadata: string,
  id: string,
) {
  return catalogNeedsAuthStatement(db).run(secret, metadata, id);
}

const insertWithMetadataStatement = statement(
  "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,metadata,created_at) VALUES(?,?,?,?,?,'needs_auth',?,?)",
);
export function insertWithMetadata(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  url: string,
  secret: string,
  metadata: string,
  created: number,
) {
  return insertWithMetadataStatement(db).run(
    id,
    owner,
    name,
    url,
    secret,
    metadata,
    created,
  );
}

const setStatusStatement = statement(
  "UPDATE mcp_connections SET status=? WHERE id=?",
);
export function setStatus(db: Database.Database, status: string, id: string) {
  return setStatusStatement(db).run(status, id);
}

const connectedCatalogStatement = statement(
  "SELECT id,name,tools FROM mcp_connections WHERE owner_id=? AND status='connected' ORDER BY id",
);
const connectedCatalogRow = QueryRecords.mcp_connections.pick({
  id: true,
  name: true,
  tools: true,
});
export function connectedCatalog(db: Database.Database, owner: string) {
  return connectedCatalogStatement(db)
    .all(owner)
    .map((row) => parseRecord(connectedCatalogRow, row, "mcp_connections"));
}

const setSecretStatement = statement(
  "UPDATE mcp_connections SET secret=? WHERE id=?",
);
export function setSecret(db: Database.Database, secret: string, id: string) {
  return setSecretStatement(db).run(secret, id);
}

const discoveredStatement = statement(
  "UPDATE mcp_connections SET tools=?,metadata=?,status='connected' WHERE id=?",
);
export function discovered(
  db: Database.Database,
  tools: string,
  metadata: string,
  id: string,
) {
  return discoveredStatement(db).run(tools, metadata, id);
}

const disableStatement = statement(
  "UPDATE mcp_connections SET status='disabled' WHERE id=?",
);
export function disable(db: Database.Database, id: string) {
  return disableStatement(db).run(id);
}

const byInstallFingerprintStatement = statement(
  "SELECT * FROM mcp_connections WHERE owner_id=? AND json_extract(metadata,'$.installFingerprint')=? AND status<>'disconnected'",
);

export function byInstallFingerprint(
  db: Database.Database,
  owner: string,
  fingerprint: string,
) {
  const row = byInstallFingerprintStatement(db).get(owner, fingerprint);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.mcp_connections, row, "mcp_connections");
}

const forOwnerStatement = statement(
  "SELECT * FROM mcp_connections WHERE owner_id=? ORDER BY created_at DESC",
);

export function forOwner(db: Database.Database, owner: string) {
  return forOwnerStatement(db)
    .all(owner)
    .map((row) =>
      parseRecord(QueryRecords.mcp_connections, row, "mcp_connections"),
    );
}

const insertStatement = statement(
  "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,created_at) VALUES(?,?,?,?,?,'needs_auth',?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  url: string,
  secret: string,
  created: number,
) {
  return insertStatement(db).run(id, owner, name, url, secret, created);
}

const disconnectStatement = statement(
  "UPDATE mcp_connections SET status='disconnected',secret=? WHERE id=?",
);
export function disconnect(db: Database.Database, secret: string, id: string) {
  return disconnectStatement(db).run(secret, id);
}

const credentialsNeedAuthStatement = statement(
  "UPDATE mcp_connections SET secret=?,status='needs_auth' WHERE id=?",
);
export function credentialsNeedAuth(
  db: Database.Database,
  secret: string,
  id: string,
) {
  return credentialsNeedAuthStatement(db).run(secret, id);
}

const githubCandidatesStatement = statement(
  "SELECT * FROM mcp_connections WHERE owner_id=? AND status='connected' ORDER BY created_at,rowid",
);

export function githubCandidates(db: Database.Database, owner: string) {
  return githubCandidatesStatement(db)
    .all(owner)
    .map((row) =>
      parseRecord(QueryRecords.mcp_connections, row, "mcp_connections"),
    );
}
