import { z } from "zod";
import { createHash } from "node:crypto";
import { db, id, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import { companionMode } from "./profile.js";
import { submit } from "./agent-runtime.js";
import {
  captureSnapshot,
  snapshotFingerprint,
  type ReviewSnapshot,
} from "./review-snapshot.js";
import { reviewRecord } from "./review-access.js";
import type { Agent } from "../shared/types.js";

const input = z.object({
  folderId: z.string().min(1),
  scope: z.enum(["uncommitted", "staged", "branch"]),
  base: z.string().trim().min(1).max(200).default("main"),
  idempotencyKey: z.string().min(8).max(150),
});
function directory(owner: string, folderId: string) {
  if (!companionMode)
    throw new Problem(
      409,
      "Local snapshot review requires a laptop workspace. Open the Loop workspace running beside your repository.",
    );
  owned("folders", folderId, owner);
  const mapping = db
    .prepare("SELECT path FROM project_paths WHERE folder_id=?")
    .get(folderId) as { path: string } | undefined;
  if (!mapping)
    throw new Problem(409, "Bind this project to a local Git repository first");
  return mapping.path;
}
export function startCodeReview(owner: string, teamId: string, value: unknown) {
  const d = input.parse(value);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        teamId,
        folderId: d.folderId,
        scope: d.scope,
        base: d.base,
      }),
    )
    .digest("hex");
  const receipt = () => {
    const prior = db
      .prepare("SELECT * FROM code_reviews WHERE owner_id=? AND request_key=?")
      .get(owner, d.idempotencyKey) as any;
    if (prior && prior.request_hash !== hash)
      throw new Problem(409, "This request key belongs to a different review");
    return prior;
  };
  const prior = receipt();
  if (prior) return reviewStatus(owner, prior.id);
  const team = owned<any>("teams", teamId, owner);
  if (team.deleted_at || team.preset_id !== "code-review")
    throw new Problem(409, "Choose a code review team");
  const config = JSON.parse(team.preset_config);
  const assignments = config.assignments as { role: string; agentId: string }[];
  if (assignments.length !== 4 || assignments[0].agentId !== team.manager_id)
    throw new Problem(409, "Review team configuration is incomplete");
  for (const a of assignments) {
    const agent = owned<Agent>("agents", a.agentId, owner);
    if (agent.retired_at)
      throw new Problem(409, "Restore all reviewers before starting a review");
  }
  const path = directory(owner, d.folderId);
  const snapshot = captureSnapshot(path, d.scope, d.base);
  const fingerprint = snapshotFingerprint(snapshot);
  if (
    snapshotFingerprint(captureSnapshot(path, d.scope, d.base)) !== fingerprint
  )
    throw new Problem(
      409,
      "Files changed during capture. Retry to review one consistent snapshot.",
    );
  return db
    .transaction(() => {
      const previous = receipt();
      if (previous) return reviewStatus(owner, previous.id);
      const reviewId = id();
      db.prepare(
        "INSERT INTO code_reviews(id,owner_id,team_id,folder_id,request_key,request_hash,snapshot,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        reviewId,
        owner,
        teamId,
        d.folderId,
        d.idempotencyKey,
        hash,
        JSON.stringify(snapshot),
        fingerprint,
        now(),
      );
      const manager = submit(owner, {
        agentId: team.manager_id,
        teamId,
        folderId: d.folderId,
        reviewId,
        input: `Review ${d.scope} changes. Consolidate the independent reviews of snapshot ${reviewId}.`,
        idempotencyKey: `review:${reviewId}:lead`,
        personal: true,
      });
      db.prepare("UPDATE code_reviews SET run_id=? WHERE id=?").run(
        manager.id,
        reviewId,
      );
      for (const a of assignments.slice(1)) {
        const child = submit(owner, {
          agentId: a.agentId,
          teamId,
          folderId: d.folderId,
          reviewId,
          input: `Independently review snapshot ${reviewId} as the ${a.role} reviewer. Read the captured files as needed and report evidence-backed findings.`,
          idempotencyKey: `review:${reviewId}:${a.role}`,
        });
        // Existing queue dependency and cancellation machinery owns this fan-out.
        db.prepare(
          "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,0)",
        ).run(manager.id, `review:${a.role}`, child.id, "{}");
      }
      return reviewStatus(owner, reviewId);
    })
    .immediate();
}
export function reviewStatus(
  owner: string,
  reviewId: string,
  freshness = false,
) {
  const r = reviewRecord(owner, reviewId);
  const s: ReviewSnapshot = JSON.parse(r.snapshot);
  const run = owned<any>("runs", r.run_id, owner);
  const reviewers = db
    .prepare(
      "SELECT r.agent_id,r.state,r.error FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=? ORDER BY d.call_id",
    )
    .all(run.id);
  let current: boolean | null = null,
    freshnessError: string | null = null;
  if (freshness) {
    try {
      current =
        snapshotFingerprint(
          captureSnapshot(directory(owner, r.folder_id), s.scope, s.base),
        ) === r.fingerprint;
    } catch (error) {
      freshnessError = (error as Error).message;
    }
  }
  return {
    id: r.id,
    conversationId: run.conversation_id,
    state: run.state,
    scope: s.scope,
    fingerprint: r.fingerprint,
    createdAt: r.created_at,
    changed: s.changed,
    omitted: s.omitted,
    reviewers,
    current,
    freshnessError,
  };
}
