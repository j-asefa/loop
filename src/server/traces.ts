import { db, now } from "./db.js";
import { owned } from "./domain.js";
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

export function agentTraces(
  owner: string,
  agent: string,
  before = Number.MAX_SAFE_INTEGER,
) {
  owned("agents", agent, owner);
  const items = db
    .prepare(
      `SELECT t.*,r.input,r.state run_state,r.conversation_id
    FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
    WHERE t.owner_id=? AND r.agent_id=? AND t.id<? AND t.kind!='message'
      AND t.trace_key NOT LIKE 'turn:%' AND ${publicTraceFilter}
    ORDER BY t.id DESC LIMIT 40`,
    )
    .all(owner, agent, before) as { id: number }[];
  return { items, next: items.length === 40 ? items.at(-1)!.id : null };
}
