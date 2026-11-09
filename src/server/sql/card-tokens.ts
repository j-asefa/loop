import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const byIdStatement = statement("SELECT * FROM card_tokens WHERE id=?");
const byIdRow = QueryRecords.card_tokens.omit({
  request_window: true,
  request_count: true,
});
export function byId(db: Database.Database, id: string) {
  const row = byIdStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(byIdRow, row, "card_tokens");
}

const activeCountStatement = statement(
  "SELECT count(*) n FROM card_tokens WHERE owner_id=? AND revoked_at IS NULL",
);
const activeCountRow = z.object({ n: z.number() });
export function activeCount(db: Database.Database, owner: string) {
  const row = activeCountStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(activeCountRow, row, "card_tokens");
}

const pruneRevokedStatement = statement(
  "DELETE FROM card_tokens WHERE owner_id=@owner AND revoked_at IS NOT NULL AND id NOT IN (SELECT id FROM card_tokens WHERE owner_id=@owner AND revoked_at IS NOT NULL ORDER BY revoked_at DESC,id DESC LIMIT 50)",
);
export function pruneRevoked(db: Database.Database, owner: string) {
  return pruneRevokedStatement(db).run({ owner });
}

const insertStatement = statement(
  "INSERT INTO card_tokens(id,owner_id,name,digest,scope,created_at) VALUES(?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string,
  owner: string,
  name: string,
  digest: string,
  scope: string,
  created: number,
) {
  return insertStatement(db).run(id, owner, name, digest, scope, created);
}

const revokeStatement = statement(
  "UPDATE card_tokens SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND owner_id=?",
);
export function revoke(
  db: Database.Database,
  time: number,
  id: string,
  owner: string,
) {
  return revokeStatement(db).run(time, id, owner);
}

const activeScopeStatement = statement(
  "SELECT scope FROM card_tokens WHERE id=? AND owner_id=? AND revoked_at IS NULL",
);
const activeScopeRow = QueryRecords.card_tokens.pick({ scope: true });
export function activeScope(db: Database.Database, id: string, owner: string) {
  const row = activeScopeStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(activeScopeRow, row, "card_tokens");
}

const byDigestStatement = statement(
  "SELECT id,owner_id,scope,revoked_at FROM card_tokens WHERE digest=?",
);
const byDigestRow = QueryRecords.card_tokens.pick({
  id: true,
  owner_id: true,
  scope: true,
  revoked_at: true,
});
export function byDigest(db: Database.Database, digest: string) {
  const row = byDigestStatement(db).get(digest);
  return row === undefined
    ? undefined
    : parseRecord(byDigestRow, row, "card_tokens");
}

const chargeStatement = statement(
  "UPDATE card_tokens SET request_window=@window,request_count=CASE WHEN request_window=@window THEN request_count+1 ELSE 1 END WHERE id=@id RETURNING request_count n",
);
const chargeRow = z.object({ n: z.number() });
export function charge(db: Database.Database, window: number, id: string) {
  const row = chargeStatement(db).get({ window, id });
  return row === undefined
    ? undefined
    : parseRecord(chargeRow, row, "card_tokens");
}

const touchStatement = statement(
  "UPDATE card_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<=?)",
);
export function touch(
  db: Database.Database,
  time: number,
  id: string,
  before: number,
) {
  return touchStatement(db).run(time, id, before);
}

const publicRow = QueryRecords.card_tokens.pick({
  id: true,
  name: true,
  scope: true,
  created_at: true,
  revoked_at: true,
  last_used_at: true,
});
const publicListStatement = statement(
  "SELECT id,name,scope,created_at,revoked_at,last_used_at FROM card_tokens WHERE owner_id=? ORDER BY created_at DESC,id DESC",
);
export function publicList(db: Database.Database, owner: string) {
  return publicListStatement(db)
    .all(owner)
    .map((row) => parseRecord(publicRow, row, "card_tokens"));
}
const publicByIdStatement = statement(
  "SELECT id,name,scope,created_at,revoked_at,last_used_at FROM card_tokens WHERE id=?",
);
export function publicById(db: Database.Database, id: string) {
  const row = publicByIdStatement(db).get(id);
  return row === undefined
    ? undefined
    : parseRecord(publicRow, row, "card_tokens");
}
