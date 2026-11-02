import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const mailFilesStatement = statement(
  "SELECT id,title name FROM artifacts WHERE owner_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id",
);
const mailFilesRow = z.object({
  id: QueryRecords.artifacts.shape.id,
  name: QueryRecords.artifacts.shape.title,
});
export function mailFiles(db: Database.Database, owner: string, files: string) {
  return mailFilesStatement(db)
    .all(owner, files)
    .map((row) => parseRecord(mailFilesRow, row, "artifacts"));
}

const ownedFileSizeStatement = statement(
  "SELECT f.size FROM artifacts a JOIN artifact_objects f ON f.artifact_id=a.id AND f.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=?",
);
const ownedFileSizeRow = QueryRecords.artifact_objects.pick({ size: true });
export function ownedFileSize(
  db: Database.Database,
  id: string,
  owner: string,
) {
  const row = ownedFileSizeStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedFileSizeRow, row, "artifacts");
}
