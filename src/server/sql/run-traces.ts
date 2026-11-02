import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";
export const publicTraceFilter = `NOT EXISTS (
  SELECT 1 FROM run_traces internal WHERE internal.run_id=t.run_id
  AND internal.trace_key=CASE WHEN substr(t.trace_key,-7)=':result'
    THEN substr(t.trace_key,1,length(t.trace_key)-7) ELSE t.trace_key END
  AND internal.title='StructuredOutput' AND json_extract(internal.metadata,'$.native')=1
)`;
const unrepresentedTrace = `NOT EXISTS (
  SELECT 1 FROM agent_activities a
  WHERE a.owner_id=t.owner_id AND a.scope=COALESCE(r.conversation_id,'run:'||r.id)
    AND a.run_id=t.run_id AND json_extract(a.record,'$.data.links.trace') IS NOT NULL
    AND json_extract(a.record,'$.data.links.trace')=t.trace_key
)`;

const legacyToolsStatement = statementVariants();
const legacyToolsRow = QueryRecords.run_traces.pick({
  run_id: true,
  trace_key: true,
  title: true,
  content: true,
  metadata: true,
  artifact_id: true,
  id: true,
});
export function legacyTools(
  db: Database.Database,
  owner: string,
  scope: string,
  before?: number,
) {
  return legacyToolsStatement(
    `SELECT t.run_id,t.trace_key,t.title,t.content,t.metadata,t.artifact_id,t.id
      FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
      WHERE t.owner_id=? AND t.kind='tool' AND (r.conversation_id=? OR 'run:'||r.id=?)
        -- Plan tool calls are represented by their plan activity.
        AND t.title NOT IN ('loop55_plan','loop_plan')
        AND ${publicTraceFilter}
        ${before === undefined ? "" : `AND ${unrepresentedTrace}`}
      AND t.id<? ORDER BY t.id ${before === undefined ? "ASC" : "DESC"} LIMIT ?`,
    db,
  )
    .all(
      owner,
      scope,
      scope,
      before ?? Number.MAX_SAFE_INTEGER,
      before === undefined ? 2000 : 101,
    )
    .map((row) => parseRecord(legacyToolsRow, row, "run_traces"));
}

const hasLegacyToolsStatement =
  statement(`SELECT 1 FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
      WHERE t.owner_id=? AND t.kind='tool' AND (r.conversation_id=? OR 'run:'||r.id=?)
        AND t.title NOT IN ('loop55_plan','loop_plan') AND ${publicTraceFilter}
        AND ${unrepresentedTrace} LIMIT 1`);
export function hasLegacyTools(
  db: Database.Database,
  owner: string,
  scope: string,
) {
  const row = hasLegacyToolsStatement(db).get(owner, scope, scope);
  return row === undefined
    ? undefined
    : parseRecord(z.object({ "1": z.number() }), row, "run_traces");
}
