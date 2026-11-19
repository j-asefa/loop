import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const sourceFields = QueryRecords.memory_sources.pick({
  id: true,
  owner_id: true,
  kind: true,
  revision: true,
  title: true,
  content: true,
});
type SourceFields = z.infer<typeof sourceFields>;

const deleteStatement = statement(
  "DELETE FROM memory_passages WHERE source_id=?",
);
const insertStatement = statement(
  "INSERT INTO memory_passages(source_id,revision,ordinal,start,end) VALUES(?,?,?,?,?)",
);
const indexStatement = statement(
  "INSERT INTO memory_passage_fts(rowid,source_id,owner_id,ordinal,title,body) VALUES(?,?,?,?,?,?)",
);

/** Replace one source revision's derived offsets and FTS rows in the caller's transaction. */
export function replace(
  db: Database.Database,
  source: SourceFields,
  passages: { start: number; end: number }[],
) {
  deleteStatement(db).run(source.id);
  for (const [ordinal, passage] of passages.entries()) {
    const { lastInsertRowid } = insertStatement(db).run(
      source.id,
      source.revision,
      ordinal,
      passage.start,
      passage.end,
    );
    indexStatement(db).run(
      lastInsertRowid,
      source.id,
      source.owner_id,
      ordinal,
      source.title,
      source.content.slice(passage.start, passage.end),
    );
  }
}

const completeStatement = statement(
  "SELECT complete FROM memory_passage_backfill",
);
export function backfillComplete(db: Database.Database) {
  return completeStatement(db).get() !== undefined;
}
const markCompleteStatement = statement(
  "INSERT OR IGNORE INTO memory_passage_backfill VALUES(1)",
);
export function finishBackfill(db: Database.Database) {
  markCompleteStatement(db).run();
}

export const MEMORY_PASSAGE_BATCH = 100;
const pendingStatement = statement(
  `SELECT s.id,s.owner_id,s.kind,s.revision,s.title,s.content FROM memory_sources s
   WHERE s.tombstone=0 AND NOT EXISTS (
     SELECT 1 FROM memory_passages p WHERE p.source_id=s.id AND p.ordinal=0 AND p.revision=s.revision
   ) ORDER BY s.id LIMIT ${MEMORY_PASSAGE_BATCH}`,
);
/** Read the next bounded batch of sources lacking a current passage revision. */
export function pending(db: Database.Database) {
  return pendingStatement(db)
    .all()
    .map((row) => parseRecord(sourceFields, row, "memory_sources"));
}

const searchStatement = statement(
  `SELECT s.id,p.revision,p.start,p.end FROM memory_passage_fts f
   JOIN memory_passages p ON p.id=f.rowid
   JOIN memory_sources s ON s.id=p.source_id AND s.revision=p.revision
   WHERE memory_passage_fts MATCH @match
     AND s.owner_id=@owner
     AND s.eligible=1 AND s.tombstone=0
     AND (s.project_id IS @project OR (s.kind='note' AND s.project_id IS NULL))
   ORDER BY rank LIMIT 75`,
);
const offsetsRow = QueryRecords.memory_passages.pick({
  start: true,
  end: true,
});
const searchRow = QueryRecords.memory_sources
  .pick({ id: true, revision: true })
  .extend(offsetsRow.shape);
const offsetsStatement = statement(
  "SELECT start,end FROM memory_passages WHERE source_id=? AND revision=? ORDER BY ordinal",
);
/** Return raw passage offsets from the already owner-checked source revision. */
export function offsets(db: Database.Database, id: string, revision: number) {
  return offsetsStatement(db)
    .all(id, revision)
    .map((row) => parseRecord(offsetsRow, row, "memory_passages"));
}
/** Rank current passages for the requested owner and project. */
export function search(
  db: Database.Database,
  match: string,
  owner: string,
  project: string | null,
) {
  return searchStatement(db)
    .all({ match, owner, project })
    .map((row) => parseRecord(searchRow, row, "memory_passages"));
}
