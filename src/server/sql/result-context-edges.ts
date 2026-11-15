import type Database from "better-sqlite3";
import { QueryRecords } from "./rows.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const deleteByResultStatement = statement(
  "DELETE FROM result_context_edges WHERE owner_id=? AND result_id=?",
);
export function deleteByResult(
  db: Database.Database,
  ownerId: string,
  resultId: string,
) {
  return deleteByResultStatement(db).run(ownerId, resultId);
}

const insertStatement = statement(
  "INSERT OR REPLACE INTO result_context_edges(owner_id,result_id,source_result_id,position,excerpt,created_at) VALUES(?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  ownerId: string,
  resultId: string,
  sourceResultId: string,
  position: number,
  excerpt: number,
  createdAt: number,
) {
  return insertStatement(db).run(
    ownerId,
    resultId,
    sourceResultId,
    position,
    excerpt,
    createdAt,
  );
}

const listByResultStatement = statement(
  "SELECT * FROM result_context_edges WHERE owner_id=? AND result_id=? ORDER BY position ASC",
);
export function listByResult(
  db: Database.Database,
  ownerId: string,
  resultId: string,
) {
  return listByResultStatement(db)
    .all(ownerId, resultId)
    .map((row) =>
      parseRecord(
        QueryRecords.result_context_edges,
        row,
        "result_context_edges",
      ),
    );
}

const listBySourceStatement = statement(
  "SELECT * FROM result_context_edges WHERE owner_id=? AND source_result_id=? ORDER BY created_at DESC, result_id ASC, position ASC",
);
export function listBySource(
  db: Database.Database,
  ownerId: string,
  sourceResultId: string,
) {
  return listBySourceStatement(db)
    .all(ownerId, sourceResultId)
    .map((row) =>
      parseRecord(
        QueryRecords.result_context_edges,
        row,
        "result_context_edges",
      ),
    );
}
