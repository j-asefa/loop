import { db, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import type { Run } from "./queue.js";

// Older runtimes saved Claude's internal JSON-envelope tool and its receipt.
// Keep the records, but exclude them from public traces and Running previews.
export const publicTraceFilter = `NOT EXISTS (
  SELECT 1 FROM run_traces internal WHERE internal.run_id=t.run_id
  AND internal.trace_key=CASE WHEN substr(t.trace_key,-7)=':result'
    THEN substr(t.trace_key,1,length(t.trace_key)-7) ELSE t.trace_key END
  AND internal.title='StructuredOutput' AND json_extract(internal.metadata,'$.native')=1
)`;

export function recordTrace(
  run: Run,
  key: string,
  data: {
    kind: "message" | "tool";
    title: string;
    content?: string;
    metadata?: unknown;
    artifactId?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,artifact_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,trace_key) DO UPDATE SET
    title=excluded.title,content=excluded.content,metadata=excluded.metadata,artifact_id=excluded.artifact_id`,
  ).run(
    run.owner_id,
    run.id,
    key,
    data.kind,
    data.title,
    data.content || "",
    JSON.stringify(data.metadata || {}),
    data.artifactId || null,
    now(),
  );
}

// Every term must match, as a prefix, in the trace or its linked tool result.
// Linked results live in artifacts, which the workspace index already covers.
function traceMatch(q: string) {
  const terms = q.match(/[\p{L}\p{N}]+/gu) || [];
  return terms.length
    ? terms
        .slice(0, 20)
        .map((t) => '"' + t + '"*')
        .join(" ")
    : null;
}

export function agentTraces(
  owner: string,
  agent: string,
  before = Number.MAX_SAFE_INTEGER,
  runId?: string,
  q?: string,
) {
  owned("agents", agent, owner);
  const match = q ? traceMatch(q) : null;
  if (q && !match) return { items: [], next: null };
  const items = db
    .prepare(
      `SELECT t.*,r.input,r.state run_state,r.error run_error,r.conversation_id, c.name server,inv.state invocation_state
    FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
    LEFT JOIN tool_invocations inv ON inv.run_id=t.run_id AND inv.owner_id=t.owner_id AND t.trace_key='tool:'||inv.call_id
    LEFT JOIN mcp_connections c ON c.id=inv.connection_id AND c.owner_id=t.owner_id
    WHERE t.owner_id=? AND r.agent_id=? AND t.id<? AND (? IS NULL OR r.id=?)
      AND (t.kind!='message' OR (json_extract(t.metadata,'$.final') IS NOT 1 AND length(trim(t.content))>0))
      AND (? IS NULL OR t.id IN (SELECT rowid FROM trace_fts WHERE trace_fts MATCH ?)
        OR 'artifact:'||t.artifact_id IN (SELECT id FROM search_fts WHERE search_fts MATCH ? AND owner_id=t.owner_id))
      AND ${publicTraceFilter}
    ORDER BY t.id DESC LIMIT 40`,
    )
    .all(
      owner,
      agent,
      before,
      runId || null,
      runId || null,
      match,
      match,
      match,
    ) as {
    id: number;
  }[];
  return { items, next: items.length === 40 ? items.at(-1)!.id : null };
}

const exportLimit = 5000;
// A complete public record of one run, final answer included, for download.
export function runTraceExport(owner: string, agent: string, runId: string) {
  const a = owned<{ id: string; name: string }>("agents", agent, owner);
  const run = db
    .prepare(
      "SELECT id,input,state,error,conversation_id,created_at,updated_at FROM runs WHERE id=? AND owner_id=? AND agent_id=?",
    )
    .get(runId, owner, agent);
  if (!run) throw new Problem(404, "Run not found");
  const rows = db
    .prepare(
      `SELECT t.id,t.trace_key,t.kind,t.title,t.content,t.metadata,t.artifact_id,t.created_at
    FROM run_traces t WHERE t.owner_id=? AND t.run_id=?
      AND (t.kind!='message' OR length(trim(t.content))>0)
      AND ${publicTraceFilter}
    ORDER BY t.id LIMIT ?`,
    )
    .all(owner, runId, exportLimit + 1) as { metadata: string }[];
  const messages = db
    .prepare(
      `SELECT m.id,m.role,m.content,m.metadata,m.created_at
    FROM conversation_transcript p JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
    WHERE p.owner_id=? AND p.run_id=? AND length(trim(m.content))>0
    ORDER BY p.position,p.phase,p.ordinal LIMIT ?`,
    )
    .all(owner, runId, exportLimit + 1) as { metadata: string }[];
  return {
    exported_at: now(),
    agent: { id: a.id, name: a.name },
    run,
    truncated: rows.length > exportLimit || messages.length > exportLimit,
    messages: messages.slice(0, exportLimit).map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata),
    })),
    traces: rows.slice(0, exportLimit).map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata),
    })),
  };
}
