import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const forCallIdStatement = statement(
  "SELECT artifact_id FROM artifact_objects WHERE run_id=? AND call_id=? AND owner_id=?",
);
const forCallIdRow = QueryRecords.artifact_objects.pick({ artifact_id: true });
export function forCallId(
  db: Database.Database,
  run: string,
  call: string,
  owner: string,
) {
  const row = forCallIdStatement(db).get(run, call, owner);
  return row === undefined
    ? undefined
    : parseRecord(forCallIdRow, row, "artifact_objects");
}

const insertStatement = statement(
  "INSERT INTO artifact_objects VALUES(?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  artifact: string,
  owner: string,
  run: string,
  call: string,
  key: string,
  mime: string,
  size: number,
  checksum: string,
) {
  return insertStatement(db).run(
    artifact,
    owner,
    run,
    call,
    key,
    mime,
    size,
    checksum,
  );
}

const forCallStatement = statement(
  "SELECT a.id,a.title,a.metadata,f.mime,f.size FROM artifact_objects f JOIN artifacts a ON a.id=f.artifact_id AND a.owner_id=f.owner_id WHERE f.run_id=? AND f.call_id=? AND f.owner_id=?",
);
const forCallRow = QueryRecords.artifact_objects
  .pick({ mime: true, size: true })
  .extend({ id: z.string(), title: z.string(), metadata: z.string() });
export function forCall(
  db: Database.Database,
  run: string,
  call: string,
  owner: string,
) {
  const row = forCallStatement(db).get(run, call, owner);
  return row === undefined
    ? undefined
    : parseRecord(forCallRow, row, "artifact_objects");
}

const ownedStatement = statement(
  "SELECT * FROM artifact_objects WHERE artifact_id=? AND owner_id=?",
);
const ownedRow = QueryRecords.artifact_objects;
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "artifact_objects");
}

const downloadStatement = statement(
  "SELECT object_key,mime,checksum FROM artifact_objects WHERE artifact_id=? AND owner_id=?",
);
const downloadRow = QueryRecords.artifact_objects.pick({
  object_key: true,
  mime: true,
  checksum: true,
});
export function download(db: Database.Database, id: string, owner: string) {
  const row = downloadStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(downloadRow, row, "artifact_objects");
}
