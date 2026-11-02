import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statementVariants } from "./statement.js";
import { filterSql, type SearchFilters } from "./search-documents.js";
const lexicalStatement = statementVariants();
const lexicalRow = QueryRecords.search_documents.extend({ rank: z.number() });
export function lexical(
  db: Database.Database,
  owner: string,
  match: string,
  filters: SearchFilters,
  at: number,
) {
  const filter = filterSql(owner, filters, at);
  return lexicalStatement(
    `SELECT d.*,bm25(search_fts) rank FROM search_fts JOIN search_documents d ON d.id=search_fts.id WHERE search_fts MATCH ? AND ${filter.sql} ORDER BY rank LIMIT 300`,
    db,
  )
    .all(match, ...filter.params)
    .map((row) => parseRecord(lexicalRow, row, "search_fts"));
}
