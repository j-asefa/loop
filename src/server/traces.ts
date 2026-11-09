import * as conversationTranscriptQueries from "./sql/conversation-transcript.js";
import * as runTracesQueries from "./sql/run-traces.js";
import * as runsQueries from "./sql/runs.js";
import type { z } from "zod";
import type { PublicAgentTrace } from "../shared/agent-contract-schemas.js";
import { db, now } from "./db.js";
import { ownedAgent, Problem } from "./domain.js";
import type { Run } from "./queue.js";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "../shared/uploads.js";

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
  runTracesQueries.upsert(
    db,
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
  const items = runTracesQueries.agentPage(
    db,
    owner,
    agent,
    before,
    runId || null,
    match,
  ) as z.input<typeof PublicAgentTrace>[];
  return { items, next: items.length === 40 ? items.at(-1)!.id : null };
}

const exportLimit = 5000;
const exportTooLarge = () =>
  new Problem(
    413,
    `This trace export exceeds ${MAX_UPLOAD_LABEL}. Read the paginated traces instead.`,
  );
// A complete public record of one run, final answer included, for download.
export function runTraceExport(owner: string, agent: string, runId: string) {
  const a = ownedAgent(agent, owner);
  const run = runsQueries.traceExport(db, runId, owner, agent);
  if (!run) throw new Problem(404, "Run not found");
  const prefix = { exported_at: now(), agent: { id: a.id, name: a.name }, run };
  const size =
    Buffer.byteLength(JSON.stringify(prefix)) +
    runTracesQueries.exportSize(db, owner, runId, exportLimit) +
    conversationTranscriptQueries.exportSize(db, owner, runId, exportLimit);
  if (size > MAX_UPLOAD_BYTES) throw exportTooLarge();
  const rows = runTracesQueries.exportRows(db, owner, runId, exportLimit);
  const messages = conversationTranscriptQueries.exportRows(
    db,
    owner,
    runId,
    exportLimit,
  );
  const result = {
    ...prefix,
    truncated:
      runTracesQueries.exportHasMore(db, owner, runId, exportLimit) ||
      conversationTranscriptQueries.exportHasMore(
        db,
        owner,
        runId,
        exportLimit,
      ),
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
