import { z } from "zod";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { db, id, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import { companionMode } from "./profile.js";
import { submit } from "./agent-runtime.js";
import {
  captureSnapshot,
  snapshotFingerprint,
  type ReviewSnapshot,
} from "./review-snapshot.js";
import { reviewRecord, type requestReviewSchema } from "./review-access.js";
import type { Agent } from "../shared/types.js";
import type { Run } from "./queue.js";

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
// The requester's checkout is either the project itself or an agent worktree
// that shares its Git repository.
function reviewable(owner: string, folderId: string, path: string) {
  const project = directory(owner, folderId);
  const common = (p: string) => {
    try {
      return realpathSync(
        execFileSync(
          "git",
          ["-C", p, "rev-parse", "--path-format=absolute", "--git-common-dir"],
          { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
        ).trim(),
      );
    } catch {
      throw new Problem(409, "The agent's checkout is not a Git repository");
    }
  };
  if (common(path) !== common(project))
    throw new Problem(409, "The agent's checkout is not part of this project's repository");
  return path;
}
export function startCodeReview(
  owner: string,
  teamId: string,
  value: unknown,
  // Agent-requested reviews capture the requester's own checkout and record
  // the requesting run as the lead's waiting parent in the same transaction.
  requester?: { path: string; runId: string; callId: string },
) {
  const d = input.parse(value);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        teamId,
        folderId: d.folderId,
        scope: d.scope,
        base: d.base,
        ...(requester && { requester: requester.runId }),
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
  const requesterAgent =
    requester && owned<any>("runs", requester.runId, owner).agent_id;
  for (const a of assignments) {
    if (a.agentId === requesterAgent)
      throw new Problem(409, "A reviewer cannot request its own team's review");
    const agent = owned<Agent>("agents", a.agentId, owner);
    if (agent.retired_at)
      throw new Problem(409, "Restore all reviewers before starting a review");
  }
  const path = requester ? reviewable(owner, d.folderId, requester.path) : directory(owner, d.folderId);
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
        "INSERT INTO code_reviews(id,owner_id,team_id,folder_id,request_key,request_hash,snapshot,fingerprint,created_at,source_path) VALUES(?,?,?,?,?,?,?,?,?,?)",
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
        requester?.path ?? null,
      );
      const manager = submit(owner, {
        agentId: team.manager_id,
        teamId,
        folderId: d.folderId,
        reviewId,
        input: `${requester ? "Another agent requested this review before opening a pull request. " : ""}Review ${d.scope} changes. Consolidate the independent reviews of snapshot ${reviewId}.`,
        idempotencyKey: `review:${reviewId}:lead`,
        personal: true,
      });
      db.prepare("UPDATE code_reviews SET run_id=? WHERE id=?").run(
        manager.id,
        reviewId,
      );
      // The requester waits on the lead like a foreground delegation, so the
      // queue resumes it and cancelling it cancels the review.
      if (requester)
        db.prepare(
          "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,0)",
        ).run(requester.runId, requester.callId + ":review", manager.id, "{}");
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
          captureSnapshot(
            r.source_path
              ? reviewable(owner, r.folder_id, r.source_path)
              : directory(owner, r.folder_id),
            s.scope,
            s.base,
          ),
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

const ACTIVE = [
  "queued",
  "running",
  "pausing",
  "paused",
  "awaiting_approval",
  "waiting_children",
];
// Review teams an agent can ask for: active, and without the agent on them.
export function requestableReviewTeams(owner: string, agentId: string) {
  return db
    .prepare(
      "SELECT id,name FROM teams WHERE owner_id=? AND deleted_at IS NULL AND preset_id='code-review' AND manager_id<>? AND NOT EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=teams.id AND m.agent_id=?) ORDER BY name",
    )
    .all(owner, agentId, agentId) as { id: string; name: string }[];
}
export function requestReview(
  run: Run,
  callId: string,
  args: z.infer<typeof requestReviewSchema>,
): { pending: string } | { report: object; failed: boolean } {
  const payload = JSON.parse(run.payload);
  const team = owned<any>("teams", args.teamId, run.owner_id);
  const folderId = payload.folderId || team.folder_id;
  if (!folderId)
    throw new Problem(409, "This conversation has no project to review");
  // A native session's project is its verified agent worktree.
  const session = db
    .prepare("SELECT project FROM companion_sessions WHERE conversation_id=?")
    .get(run.conversation_id) as { project: string } | undefined;
  const status = startCodeReview(
    run.owner_id,
    team.id,
    {
      folderId,
      scope: args.scope,
      base: args.base,
      idempotencyKey:
        "agent:" +
        createHash("sha256")
          .update(run.id + ":" + callId)
          .digest("hex"),
    },
    {
      path: session?.project ?? directory(run.owner_id, folderId),
      runId: run.id,
      callId,
    },
  );
  if (ACTIVE.includes(status.state)) return { pending: callId };
  const lead = owned<Run>("runs", reviewRecord(run.owner_id, status.id).run_id, run.owner_id);
  return {
    failed: status.state !== "completed",
    report: {
      reviewId: status.id,
      conversationId: status.conversationId,
      state: status.state,
      scope: status.scope,
      fingerprint: status.fingerprint,
      changed: status.changed,
      omitted: status.omitted,
      reviewers: status.reviewers,
      report: (lead.result || "").slice(0, 16000),
      error: lead.error,
      note: "The review covers only the captured snapshot; edits made after capture are not reviewed and no tests were run. Fix confirmed findings and request another review before opening the pull request.",
    },
  };
}
