import type Database from "better-sqlite3";
import { QueryRecords } from "./rows.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

// Findings are append-only: a repeated detection keeps the first record.
const insertStatement = statement(
  "INSERT OR IGNORE INTO result_defects(owner_id,result_id,defect,evidence,detected_at) VALUES(?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  row: {
    ownerId: string;
    resultId: string;
    defect: string;
    evidence: string;
    detectedAt: number;
  },
) {
  return insertStatement(db).run(
    row.ownerId,
    row.resultId,
    row.defect,
    row.evidence,
    row.detectedAt,
  );
}

const listByResultStatement = statement(
  "SELECT * FROM result_defects WHERE owner_id=? AND result_id=? ORDER BY defect ASC",
);
export function listByResult(
  db: Database.Database,
  ownerId: string,
  resultId: string,
) {
  return listByResultStatement(db)
    .all(ownerId, resultId)
    .map((row) =>
      parseRecord(QueryRecords.result_defects, row, "result_defects"),
    );
}
