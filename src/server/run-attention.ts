import * as runsQueries from "./sql/runs.js";
import * as messagesQueries from "./sql/messages.js";
import { z } from "zod";

import { db, emit, now } from "./db.js";
import { ownedRunControl, Problem } from "./domain.js";
import { RunIdentity, transition } from "./queue.js";
import type { RunEventPayload } from "../shared/workspace-events.js";

// Call inside the root's transaction. A damaged child payload cannot prevent
// healthy siblings from stopping, and a foreign link never grants authority.
function cancelChildren(
  owner: string,
  root: string,
  reason: RunEventPayload = {},
) {
  const pending = [root],
    visited = new Set<string>();
  while (pending.length) {
    const parent = pending.pop()!;
    if (visited.has(parent)) continue;
    visited.add(parent);
    db.prepare(
      "UPDATE approvals SET state='rejected' WHERE owner_id=? AND run_id=? AND state='pending'",
    ).run(owner, parent);
    const children = z
      .array(RunIdentity)
      .parse(
        runsQueries.cancellableChildren(
          db,
          owner,
          parent,
          parent,
          owner,
          parent,
        ),
      );
    for (const child of children) {
      transition(child, "cancelled", reason);
      pending.push(child.id);
    }
  }
}

export function cancelRun(owner: string, runId: string) {
  return db
    .transaction(() => {
      const run = ownedRunControl(runId, owner);
      if (!transition(run, "cancelled"))
        throw new Problem(
          409,
          "That action is not available in the current state",
        );
      cancelChildren(owner, run.id);
      return { ok: true };
    })
    .immediate();
}

export function dismissRun(owner: string, runId: string) {
  return db
    .transaction(() => {
      const run = ownedRunControl(runId, owner);
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
        const reason = { reason: "Dismissed by you" };
        transition(run, "cancelled", reason);
        cancelChildren(owner, run.id, reason);
      }
      runsQueries.dismissAttention(db, now(), run.id, owner);
      emit(owner, run.id, "attention.dismissed", {});
      return { ok: true };
    })
    .immediate();
}

export function listRuns(owner: string, teams: string[] = [], active = false) {
  return runsQueries.attention(db, owner, teams, active).map((row) => {
    const run = z.object({ id: z.string() }).passthrough().parse(row);
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
        messagesQueries.latestAssistantContent(db, owner, runId) as
          { content: string } | undefined
      )?.content
    : undefined;
  if (artifact && latest) artifact.content = latest;
  return { latest, artifact: artifact || null };
}
