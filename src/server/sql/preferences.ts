import type Database from "better-sqlite3";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement("SELECT * FROM preferences WHERE owner_id=?");

export function owned(db: Database.Database, owner: string) {
  const row = ownedStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.preferences, row, "preferences");
}

const upsertStatement = statement(
  "INSERT INTO preferences VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET embedding_connection=excluded.embedding_connection,embedding_model=excluded.embedding_model,embedding_enabled=excluded.embedding_enabled",
);
export function upsert(
  db: Database.Database,
  owner: string,
  connection: string | null,
  model: string,
  enabled: number,
) {
  return upsertStatement(db).run(owner, connection, model, enabled);
}

const embeddingConnectionStatement = statement(
  "SELECT c.id,c.owner_id,p.embedding_model FROM preferences p JOIN connections c ON c.id=p.embedding_connection AND c.owner_id=p.owner_id WHERE p.owner_id=? AND p.embedding_enabled=1 AND c.provider='openai' AND c.status='connected'",
);
const embeddingConnectionRow = QueryRecords.connections
  .pick({ id: true, owner_id: true })
  .extend({ embedding_model: QueryRecords.preferences.shape.embedding_model });
export function embeddingConnection(db: Database.Database, owner: string) {
  const row = embeddingConnectionStatement(db).get(owner);
  return row === undefined
    ? undefined
    : parseRecord(embeddingConnectionRow, row, "preferences");
}

const embeddingOwnersStatement = statement(
  "SELECT owner_id FROM preferences WHERE embedding_enabled=1",
);
const embeddingOwnersRow = QueryRecords.preferences.pick({ owner_id: true });
export function embeddingOwners(db: Database.Database) {
  return embeddingOwnersStatement(db)
    .all()
    .map((row) => parseRecord(embeddingOwnersRow, row, "preferences"));
}
