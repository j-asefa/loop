import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
const upsertStatement = statement(
  "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,artifact_id,created_at)\n    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,trace_key) DO UPDATE SET\n    title=excluded.title,content=excluded.content,metadata=excluded.metadata,artifact_id=excluded.artifact_id",
);
export function upsert(
  db: Database.Database,
  owner: string,
  run: string,
  key: string,
  kind: string,
  title: string,
  content: string,
  metadata: string,
  artifact: string | null,
  created: number,
) {
  return upsertStatement(db).run(
    owner,
    run,
    key,
    kind,
    title,
    content,
    metadata,
    artifact,
    created,
  );
}

const agentPageStatement =
  statement(`SELECT t.*,r.input,r.state run_state,r.error run_error,r.conversation_id, c.name server,inv.state invocation_state
    FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
    LEFT JOIN tool_invocations inv ON inv.run_id=t.run_id AND inv.owner_id=t.owner_id AND t.trace_key='tool:'||inv.call_id
    LEFT JOIN mcp_connections c ON c.id=inv.connection_id AND c.owner_id=t.owner_id
    WHERE t.owner_id=? AND r.agent_id=? AND t.id<? AND (? IS NULL OR r.id=?)
      AND (t.kind!='message' OR (json_extract(t.metadata,'$.final') IS NOT 1 AND length(trim(t.content))>0))
      AND (? IS NULL OR t.id IN (SELECT rowid FROM trace_fts WHERE trace_fts MATCH ?)
        OR 'artifact:'||t.artifact_id IN (SELECT id FROM search_fts WHERE search_fts MATCH ? AND owner_id=t.owner_id))
    ORDER BY t.id DESC LIMIT 40`);
const agentPageRow = QueryRecords.run_traces.extend({
  input: z.string(),
  run_state: z.string(),
  run_error: z.string().nullable(),
  conversation_id: z.string().nullable(),
  server: z.string().nullable(),
  invocation_state: z.string().nullable(),
});
export function agentPage(
  db: Database.Database,
  owner: string,
  agent: string,
  before: number,
  run: string | null,
  match: string | null,
) {
  return agentPageStatement(db)
    .all(owner, agent, before, run, run, match, match, match)
    .map((row) => parseRecord(agentPageRow, row, "run_traces"));
}

const traceSelection = `FROM run_traces t WHERE t.owner_id=? AND t.run_id=?
      AND (t.kind!='message' OR length(trim(t.content))>0)
    ORDER BY t.id`;
const traceSql = `SELECT t.id,t.trace_key,t.kind,t.title,t.content,t.metadata,t.artifact_id,t.created_at
    ${traceSelection} LIMIT ?`;
const exportRowsStatement = statement(traceSql);
const exportSizeStatement = statement(
  `SELECT COALESCE(SUM(COALESCE(length(CAST(trace_key AS BLOB)),0)+COALESCE(length(CAST(kind AS BLOB)),0)+COALESCE(length(CAST(title AS BLOB)),0)+COALESCE(length(CAST(content AS BLOB)),0)+COALESCE(length(CAST(metadata AS BLOB)),0)+COALESCE(length(CAST(artifact_id AS BLOB)),0)),0) size FROM (${traceSql})`,
);
const exportHasMoreStatement = statement(
  `SELECT 1 ${traceSelection} LIMIT 1 OFFSET ?`,
);
const exportRow = QueryRecords.run_traces.pick({
  id: true,
  trace_key: true,
  kind: true,
  title: true,
  content: true,
  metadata: true,
  artifact_id: true,
  created_at: true,
});
export function exportRows(
  db: Database.Database,
  owner: string,
  run: string,
  limit: number,
) {
  return exportRowsStatement(db)
    .all(owner, run, limit)
    .map((row) => parseRecord(exportRow, row, "run-traces"));
}
export function exportSize(
  db: Database.Database,
  owner: string,
  run: string,
  limit: number,
) {
  return parseRecord(
    z.object({ size: z.number() }),
    exportSizeStatement(db).get(owner, run, limit),
    "run-traces",
  ).size;
}
export function exportHasMore(
  db: Database.Database,
  owner: string,
  run: string,
  limit: number,
) {
  const row = exportHasMoreStatement(db).get(owner, run, limit);
  return (
    row !== undefined &&
    !!parseRecord(z.object({ "1": z.number() }), row, "run-traces")
  );
}
