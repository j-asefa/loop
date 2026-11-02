import * as runsQueries from "./sql/runs.js";
import type { z } from "zod";
import type { PublicAgentTrace } from "../shared/agent-contract-schemas.js";
import { db, now } from "./db.js";
import { ownedAgent, Problem } from "./domain.js";
import type { Run } from "./queue.js";
import { MAX_UPLOAD_BYTES } from "../shared/uploads.js";

// Older runtimes saved Claude's internal JSON-envelope tool and its receipt.
// Keep the records, but exclude them from public traces and Running previews.
export { publicTraceFilter } from "./sql/run-traces.js";
import { publicTraceFilter } from "./sql/run-traces.js";

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
  ownedAgent(agent, owner);
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
    ) as z.input<typeof PublicAgentTrace>[];
  return { items, next: items.length === 40 ? items.at(-1)!.id : null };
}

const exportLimit = 5000;
const exportTooLarge = () =>
  new Problem(
    413,
    "This trace export exceeds 25 MB. Read the paginated traces instead.",
  );
// A complete public record of one run, final answer included, for download.
export function runTraceExport(owner: string, agent: string, runId: string) {
  const a = ownedAgent(agent, owner);
  const run = runsQueries.traceExport(db, runId, owner, agent);
  if (!run) throw new Problem(404, "Run not found");
  const traceSelection = `FROM run_traces t WHERE t.owner_id=? AND t.run_id=?
      AND (t.kind!='message' OR length(trim(t.content))>0)
      AND ${publicTraceFilter}
    ORDER BY t.id`;
  const messageSelection = `FROM conversation_transcript p JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
    WHERE p.owner_id=? AND p.run_id=? AND length(trim(m.content))>0
    ORDER BY p.position,p.phase,p.ordinal`;
  const traceSql = `SELECT t.id,t.trace_key,t.kind,t.title,t.content,t.metadata,t.artifact_id,t.created_at
    ${traceSelection} LIMIT ?`;
  const messageSql = `SELECT m.id,m.role,m.content,m.metadata,m.created_at
    ${messageSelection} LIMIT ?`;
  // Refuse oversized stored text before materializing it in JS. Reuse the
  // owning projection's selections, including its public trace filter.
  const rawSize = (sql: string, fields: string[]) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(${fields.map((field) => `COALESCE(length(CAST(${field} AS BLOB)),0)`).join("+")}),0) size FROM (${sql})`,
        )
        .get(owner, runId, exportLimit) as { size: number }
    ).size;
  const prefix = { exported_at: now(), agent: { id: a.id, name: a.name }, run };
  const size =
    Buffer.byteLength(JSON.stringify(prefix)) +
    rawSize(traceSql, [
      "trace_key",
      "kind",
      "title",
      "content",
      "metadata",
      "artifact_id",
    ]) +
    rawSize(messageSql, ["id", "role", "content", "metadata"]);
  if (size > MAX_UPLOAD_BYTES) throw exportTooLarge();
  // Probe for another record without loading its potentially large contents.
  const hasMore = (selection: string) =>
    !!db
      .prepare(`SELECT 1 ${selection} LIMIT 1 OFFSET ?`)
      .get(owner, runId, exportLimit);
  const rows = db.prepare(traceSql).all(owner, runId, exportLimit) as {
    metadata: string;
  }[];
  const messages = db.prepare(messageSql).all(owner, runId, exportLimit) as {
    metadata: string;
  }[];
  const result = {
    ...prefix,
    truncated: hasMore(traceSelection) || hasMore(messageSelection),
    messages: messages.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata),
    })),
    traces: rows.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata),
    })),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_UPLOAD_BYTES)
    throw exportTooLarge();
  return result;
}
