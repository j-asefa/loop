import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

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

export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.artifact_objects, row, "artifact_objects");
}

const libraryStatements = statementVariants();
const libraryRow = z.object({
  id: z.string(),
  title: z.string(),
  metadata: z.string(),
  created_at: z.number(),
  conversation_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  project_name: z.string().nullable(),
  cursor: z.number(),
});
const libraryChoice = z.object({ id: z.string(), name: z.string() });
export function library(
  db: Database.Database,
  owner: string,
  query: {
    q: string;
    agent?: string;
    project?: string;
    type: string;
    before?: number;
  },
  projects?: (string | null)[],
) {
  const from = `FROM artifact_objects o
    JOIN artifacts a ON a.id=o.artifact_id AND a.owner_id=o.owner_id
    LEFT JOIN agents g ON g.id=a.agent_id AND g.owner_id=a.owner_id
    LEFT JOIN folders f ON f.id=a.folder_id AND f.owner_id=a.owner_id
    LEFT JOIN conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id`;
  let where = "o.owner_id=?";
  const params: unknown[] = [owner];
  if (query.q) {
    where +=
      " AND (instr(lower(a.title),lower(?))>0 OR instr(lower(COALESCE(json_extract(a.metadata,'$.name'),'')),lower(?))>0)";
    params.push(query.q, query.q);
  }
  if (query.agent) {
    where += " AND a.agent_id=?";
    params.push(query.agent);
  }
  if (query.project) {
    where +=
      " AND EXISTS(SELECT 1 FROM json_each(?) WHERE value IS a.folder_id)";
    params.push(JSON.stringify(projects));
  }
  const type = `CASE WHEN o.mime LIKE 'image/%' THEN 'image'
    WHEN o.mime LIKE 'video/%' THEN 'video'
    WHEN o.mime IN ('text/html','application/xhtml+xml') THEN 'html' ELSE 'other' END`;
  if (query.type !== "all") {
    where += ` AND (${type})=?`;
    params.push(query.type);
  }
  if (query.before) {
    where += " AND o.rowid<?";
    params.push(query.before);
  }
  const rows = libraryStatements(
    `SELECT a.id,a.title,
    json_object('name',json_extract(a.metadata,'$.name'),'mime',o.mime,'size',o.size) metadata,
    a.created_at,c.id conversation_id,g.name agent_name,f.name project_name,o.rowid cursor
    ${from} WHERE ${where} ORDER BY o.rowid DESC LIMIT 41`,
    db,
  )
    .all(...params)
    .map((row) => parseRecord(libraryRow, row, "artifact_objects"));
  return {
    items: rows.slice(0, 40),
    next: rows.length > 40 ? rows[39].cursor : null,
    agents: libraryStatements(
      `SELECT DISTINCT g.id,g.name ${from} WHERE o.owner_id=? AND g.id IS NOT NULL ORDER BY g.name,g.id`,
      db,
    )
      .all(owner)
      .map((row) => parseRecord(libraryChoice, row, "artifact_objects")),
    projects: libraryStatements(
      `WITH RECURSIVE ancestors(id,parent_id,name) AS (
      SELECT DISTINCT f.id,f.parent_id,f.name ${from} WHERE o.owner_id=? AND f.id IS NOT NULL
      UNION
      SELECT f.id,f.parent_id,f.name FROM folders f JOIN ancestors child ON child.parent_id=f.id WHERE f.owner_id=?
    ) SELECT id,name FROM ancestors ORDER BY name,id`,
      db,
    )
      .all(owner, owner)
      .map((row) => parseRecord(libraryChoice, row, "artifact_objects")),
  };
}

const cardPublishedStatement = statement(
  "SELECT 1 FROM artifact_objects WHERE owner_id=? AND artifact_id=?",
);
const cardPublishedRow = z.object({ "1": z.number() });
export function cardPublished(
  db: Database.Database,
  owner: string,
  id: string,
) {
  const row = cardPublishedStatement(db).get(owner, id);
  return row === undefined
    ? undefined
    : parseRecord(cardPublishedRow, row, "artifact_objects");
}
