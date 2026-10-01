import { db, emit, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import { transition, type Run } from "./queue.js";
import { publicTraceFilter } from "./traces.js";

export function dismissRun(owner: string, runId: string) {
  return db
    .transaction(() => {
      const run = owned<
        Run & {
          attention_dismissed_at: number | null;
          worker_id: string | null;
        }
      >("runs", runId, owner);
      if (run.attention_dismissed_at) return { ok: true };
      const stopped = ["failed", "interrupted"].includes(run.state);
      const waiting =
        ["queued", "paused", "awaiting_approval"].includes(run.state) ||
        (run.state === "running" && run.worker_id === null);
      if (!stopped && !waiting)
        throw new Problem(
          409,
          "This task has changed. Refresh before dismissing it.",
        );
      if (waiting) {
        const pending = [run.id],
          visited = new Set<string>();
        while (pending.length) {
          const id = pending.pop()!;
          if (visited.has(id)) continue;
          visited.add(id);
          const task = owned<Run>("runs", id, owner);
          transition(task, "cancelled", { reason: "Dismissed by you" });
          db.prepare(
            "UPDATE approvals SET state='rejected' WHERE owner_id=? AND run_id=? AND state='pending'",
          ).run(owner, id);
          const children = db
            .prepare(
              "SELECT child_run_id id FROM delegations WHERE parent_run_id=? UNION SELECT child_run_id id FROM workflow_steps WHERE run_id=? AND child_run_id IS NOT NULL",
            )
            .all(id, id) as { id: string }[];
          pending.push(...children.map((c) => c.id));
        }
      }
      db.prepare(
        "UPDATE runs SET attention_dismissed_at=? WHERE id=? AND owner_id=?",
      ).run(now(), run.id, owner);
      emit(owner, run.id, "attention.dismissed", {});
      return { ok: true };
    })
    .immediate();
}

export function listRuns(owner: string, teams: string[] = [], active = false) {
  const filters = teams.length
    ? " AND json_extract(r.payload,'$.teamId') IN (" +
      teams.map(() => "?").join(",") +
      ")"
    : "";
  const states = active
    ? " AND r.state NOT IN ('completed','cancelled') AND r.attention_dismissed_at IS NULL"
    : "";
  const order = active
    ? "CASE WHEN r.state IN ('running','pausing') AND r.worker_id IS NOT NULL THEN 0 WHEN r.state IN ('queued','running','pausing','awaiting_approval','paused') THEN 1 ELSE 2 END,"
    : "";
  return db
    .prepare(
      `SELECT r.*,CASE WHEN r.state IN ('running','pausing') AND r.worker_id IS NULL THEN 'waiting_children' ELSE r.state END AS state,(SELECT count(*)+1 FROM runs older WHERE older.agent_id=r.agent_id AND older.state IN ('queued','running','pausing','paused','awaiting_approval','waiting_children') AND (COALESCE(older.queue_rank,older.created_at)<COALESCE(r.queue_rank,r.created_at) OR (COALESCE(older.queue_rank,older.created_at)=COALESCE(r.queue_rank,r.created_at) AND older.rowid<r.rowid))) queue_position,(SELECT substr(m.content,1,320) FROM messages m WHERE m.run_id=r.id AND m.role='assistant' ORDER BY m.rowid DESC LIMIT 1) preview,(SELECT step_id FROM workflow_steps s WHERE s.run_id=r.id ORDER BY position DESC LIMIT 1) stage FROM runs r WHERE r.owner_id=?${filters}${states} ORDER BY ${order}r.created_at DESC,r.rowid DESC LIMIT 200`,
    )
    .all(owner, ...teams)
    .map((row) => {
      const run = row as Run;
      const { latest, artifact } = runPreview(owner, run.id);
      return {
        ...run,
        ...(latest ? { preview: latest } : {}),
        preview_artifact: artifact,
      };
    });
}

/**
 * What a run has produced so far: its result artifact, if one exists, and
 * the newest public update when the artifact has no content yet.
 */
export function runPreview(owner: string, runId: string) {
  const artifact = db
    .prepare(
      `SELECT a.*,r.state run_state,r.error run_error,
        json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata
        FROM agent_checkpoints cp JOIN artifacts a ON a.id=cp.artifact_id AND a.owner_id=?
        JOIN runs r ON r.id=cp.run_id WHERE cp.run_id=?`,
    )
    .get(owner, runId) as
    ({ content: string } & Record<string, unknown>) | undefined;
  const latest = !artifact?.content
    ? (
        db
          .prepare(
            `SELECT t.content FROM run_traces t WHERE t.owner_id=? AND t.run_id=? AND t.kind='message' AND length(trim(t.content))>0 AND ${publicTraceFilter} ORDER BY t.id DESC LIMIT 1`,
          )
          .get(owner, runId) as { content: string } | undefined
      )?.content
    : undefined;
  if (artifact && latest) artifact.content = latest;
  return { latest, artifact: artifact || null };
}
