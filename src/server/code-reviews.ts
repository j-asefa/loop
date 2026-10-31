import { ReviewInput } from "../shared/team-contract-schemas.js";
import type { QueryRow } from "./query-records.js";

import { z } from "zod";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { db, id, now } from "./db.js";
import {
  ownedFolder,
  ownedTeam,
  ownedAgent,
  ownedRun,
  Problem,
} from "./domain.js";
import { companionMode } from "./profile.js";
import { submit } from "./agent-runtime.js";
import { captureSnapshot, snapshotFingerprint } from "./review-snapshot.js";
import { reviewSnapshot, type requestReviewSchema } from "./review-access.js";
import { inheritFleetEffect } from "./fleet-effect-authorizations.js";

import type { Run } from "./queue.js";

function directory(owner: string, folderId: string) {
  if (!companionMode)
    throw new Problem(
      409,
      "Local snapshot review requires a laptop workspace. Open the Loop55 workspace running beside your repository.",
    );
  ownedFolder(folderId, owner);
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
          {
            encoding: "utf8",
            timeout: 10000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ).trim(),
      );
    } catch {
      throw new Problem(409, "The agent's checkout is not a Git repository");
    }
  };
  if (common(path) !== common(project))
    throw new Problem(
      409,
      "The agent's checkout is not part of this project's repository",
    );
  return path;
}
export function startCodeReview(...args: Parameters<typeof ensureCodeReview>) {
  return reviewStatus(args[0], ensureCodeReview(...args));
}
function ensureCodeReview(
  owner: string,
  teamId: string,
  value: unknown,
  // Agent-requested reviews capture the requester's own checkout and record
  // the requesting run as the lead's parent in the same transaction.
  requester?: { path: string; runId: string; callId: string },
) {
  const d = ReviewInput.parse(value);
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
      .prepare(
        "SELECT id,request_hash FROM code_reviews WHERE owner_id=? AND request_key=?",
      )
      .get(owner, d.idempotencyKey) as QueryRow<"code_reviews"> | undefined;
    if (prior && prior.request_hash !== hash)
      throw new Problem(409, "This request key belongs to a different review");
    return prior;
  };
  const prior = receipt();
  if (prior) return prior.id as string;
  const team = ownedTeam(teamId, owner);
  if (team.deleted_at || team.preset_id !== "code-review")
    throw new Problem(409, "Choose a code review team");
  const config = z
    .object({
      assignments: z.array(
        z.object({ role: z.string(), agentId: z.string().min(1) }),
      ),
    })
    .parse(JSON.parse(team.preset_config || "null"));
  const assignments = config.assignments;
  if (assignments.length !== 4 || assignments[0].agentId !== team.manager_id)
    throw new Problem(409, "Review team configuration is incomplete");
  const requesterAgent = requester && ownedRun(requester.runId, owner).agent_id;
  for (const a of assignments) {
    if (a.agentId === requesterAgent)
      throw new Problem(409, "A reviewer cannot request its own team's review");
    const agent = ownedAgent(a.agentId, owner);
    if (agent.retired_at)
      throw new Problem(409, "Restore all reviewers before starting a review");
  }
  const path = requester
    ? reviewable(owner, d.folderId, requester.path)
    : directory(owner, d.folderId);
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
      if (previous) return previous.id as string;
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
        realpathSync(path),
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
      if (requester)
        inheritFleetEffect(owner, "run", requester.runId, manager.id);
      db.prepare("UPDATE code_reviews SET run_id=? WHERE id=?").run(
        manager.id,
        reviewId,
      );
      // Start with a foreground link; requestReview promotes nonblocking
      // requests to background before returning. Both retain cancellation.
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
        inheritFleetEffect(owner, "run", manager.id, child.id);
        // Existing queue dependency and cancellation machinery owns this fan-out.
        db.prepare(
          "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,0)",
        ).run(manager.id, `review:${a.role}`, child.id, "{}");
      }
      return reviewId;
    })
    .immediate();
}
export function reviewStatus(
  owner: string,
  reviewId: string,
  freshness = false,
) {
  const { record: r, snapshot: s } = reviewSnapshot(owner, reviewId);
  const run = ownedRun(r.run_id, owner);
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
            Object.hasOwn(s, "context") ? "references" : "legacy-inline",
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
    changed: [...s.changed],
    omitted: [...s.omitted],
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
  const payload = run.payload;
  const team = ownedTeam(args.teamId, run.owner_id);
  const folderId = payload.folderId || team.folder_id;
  if (!folderId)
    throw new Problem(409, "This conversation has no project to review");
  // A native session's project is its verified agent worktree.
  const session = db
    .prepare("SELECT project FROM companion_sessions WHERE conversation_id=?")
    .get(run.conversation_id) as { project: string } | undefined;
  const reviewId = ensureCodeReview(
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
  // Async reviews preserve cancellation/provenance without blocking ordinary
  // delegation resumption or live steering. Also upgrades old pending receipts.
  if (!args.wait)
    db.prepare(
      "UPDATE delegations SET background=1 WHERE parent_run_id=? AND call_id=?",
    ).run(run.id, callId + ":review");
  // Waiting calls poll frequently. Keep captured repository contents out of
  // this path: snapshots can be many megabytes and never change while waiting.
  const progress = db
    .prepare(
      "SELECT r.id,r.state FROM code_reviews c JOIN runs r ON r.id=c.run_id AND r.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=?",
    )
    .get(reviewId, run.owner_id) as { id: string; state: string } | undefined;
  if (!progress) throw new Problem(404, "Review not found");
  if (ACTIVE.includes(progress.state) && args.wait) return { pending: callId };
  return agentReviewReport(run, reviewId);
}

function agentReviewReport(
  run: Run,
  reviewId: string,
): { report: object; failed: boolean } {
  const record = db
    .prepare(
      "SELECT c.run_id,r.state FROM code_reviews c JOIN runs r ON r.id=c.run_id AND r.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=?",
    )
    .get(reviewId, run.owner_id) as
    { run_id: string; state: string } | undefined;
  if (!record) throw new Problem(404, "Review not found");
  if (ACTIVE.includes(record.state))
    return {
      failed: false,
      report: {
        reviewId,
        state: record.state,
        note: "Review is still running. Use loop55_review_status with this reviewId later to retrieve the report. Do not submit another review of the same snapshot or busy-wait.",
      },
    };
  const status = reviewStatus(run.owner_id, reviewId);
  const lead = ownedRun(record.run_id, run.owner_id);
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

// Durable delegation provenance authorizes recovery across turns, without
// granting access to another agent's reviews (even for the same owner).
export function requestedReviewStatus(run: Run, reviewId?: string) {
  const reviews = db
    .prepare(
      `SELECT c.id AS reviewId,r.state,c.fingerprint,c.created_at AS createdAt FROM code_reviews c
    JOIN runs r ON r.id=c.run_id AND r.owner_id=c.owner_id
    JOIN delegations d ON d.child_run_id=c.run_id
    JOIN runs p ON p.id=d.parent_run_id AND p.owner_id=c.owner_id
    WHERE c.owner_id=? AND p.agent_id=? AND (? IS NULL OR c.id=?)
    ORDER BY c.created_at DESC,c.id LIMIT 10`,
    )
    .all(run.owner_id, run.agent_id, reviewId ?? null, reviewId ?? null) as {
    reviewId: string;
    state: string;
    fingerprint: string;
    createdAt: number;
  }[];
  if (reviewId) {
    if (!reviews.length) throw new Problem(404, "Requested review not found");
    return agentReviewReport(run, reviewId);
  }
  return {
    failed: false,
    report: {
      reviews,
    },
  };
}
