import {
  filterSql,
  eligibleText,
  type SearchFilters,
} from "./search-documents.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const removeOwnerStatement = statement(
  "DELETE FROM embeddings WHERE owner_id=?",
);
export function removeOwner(db: Database.Database, owner: string) {
  return removeOwnerStatement(db).run(owner);
}

const replaceStatement = statement(
  "INSERT OR REPLACE INTO embeddings VALUES(?,?,?,?,?,?)",
);
export function replace(
  db: Database.Database,
  id: string,
  owner: string,
  model: string,
  vector: string,
  hash: string,
  updated: number,
) {
  return replaceStatement(db).run(id, owner, model, vector, hash, updated);
}

const searchStatement = statementVariants();
const searchRow = QueryRecords.search_documents.extend({ vector: z.string() });
export function search(
  db: Database.Database,
  owner: string,
  filters: SearchFilters,
  model: string,
  at: number,
) {
  const filter = filterSql(owner, filters, at);
  return searchStatement(
    `SELECT d.*,e.vector FROM embeddings e JOIN search_documents d ON d.id=e.document_id WHERE e.owner_id=? AND ${filter.sql} AND e.model=? AND ${eligibleText}`,
    db,
  )
    .all(owner, ...filter.params, model)
    .map((row) => parseRecord(searchRow, row, "embeddings"));
}
