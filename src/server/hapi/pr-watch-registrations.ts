import { db, now } from "../db.js";
import { GithubError, githubTokens } from "../github-api.js";
import type { Run } from "../queue.js";
import type { NativeSession } from "./contracts.js";
import { createdPullRequest } from "../../shared/pr-command.js";

type Registration = {
  run_id: string;
  external_id: string;
  environment_id: string;
  generation: number;
  repo_owner: string;
  repo_name: string;
  number: number;
  attempts: number;
};
const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 8;
const MAX_AGE_MS = 7 * 86400_000;
let polling = false;

/** Called inside the projection transaction, before its cursor can advance. */
export function queuePrWatchRegistration(
  session: NativeSession,
  run: Run,
  externalId: string,
  command: string,
  output: string,
) {
  const pr = createdPullRequest(command, output);
  if (!pr || !run.agent_id || !githubTokens(run.owner_id).length) return;
  db.prepare(
    `INSERT OR IGNORE INTO pr_watch_registrations
    (run_id,external_id,environment_id,generation,repo_owner,repo_name,number)
    VALUES(?,?,?,?,?,?,?)`,
  ).run(
    run.id,
    externalId,
    session.environment_id,
    session.generation,
    pr.owner,
    pr.repo,
    pr.number,
  );
}

function currentRun(registration: Registration) {
  return db
    .prepare(
      `SELECT r.* FROM runs r
    JOIN native_dispatches d ON d.run_id=r.id AND d.conversation_id=r.conversation_id
    JOIN native_sessions s ON s.conversation_id=d.conversation_id AND s.owner_id=r.owner_id
    JOIN execution_environments e ON e.host_id=s.environment_id AND e.owner_id=r.owner_id
    WHERE r.id=? AND d.environment_id=? AND d.generation=?
      AND s.environment_id=d.environment_id AND s.generation=d.generation
      AND e.generation=s.generation AND e.revoked_at IS NULL`,
    )
    .get(
      registration.run_id,
      registration.environment_id,
      registration.generation,
    ) as Run | undefined;
}

/** Independent of Hub history, so even an idle/offline session can recover. */
export async function pollPrWatchRegistrations(
  time = now(),
) {
  if (polling) return;
  polling = true;
  try {
    db.prepare(
      `DELETE FROM pr_watch_registrations WHERE attempts>=? OR run_id IN
    (SELECT id FROM runs WHERE created_at<?)`,
    ).run(MAX_ATTEMPTS, time - MAX_AGE_MS);
    const due = db
      .prepare(
        `SELECT p.* FROM pr_watch_registrations p
    JOIN runs r ON r.id=p.run_id
    WHERE p.next_attempt_at<=?
    ORDER BY p.next_attempt_at LIMIT 2`,
      )
      .all(time) as Registration[];
    for (const pending of due) {
      // Reserve longer than the GitHub request deadline. A crash leaves a due
      // row after this lease, and a second worker cannot claim it concurrently.
      const eligible = currentRun(pending);
      const hasToken = eligible && githubTokens(eligible.owner_id).length > 0;
      const claimed = db
        .prepare(
          `UPDATE pr_watch_registrations
      SET next_attempt_at=?,attempts=attempts+?
      WHERE run_id=? AND external_id=? AND next_attempt_at<=?`,
        )
        .run(
          time + RETRY_MS,
          hasToken ? 1 : 0,
          pending.run_id,
          pending.external_id,
          time,
        );
      if (!claimed.changes) continue;
      const remove = () =>
        db
          .prepare(
            "DELETE FROM pr_watch_registrations WHERE run_id=? AND external_id=? AND attempts=?",
          )
          .run(
            pending.run_id,
            pending.external_id,
            pending.attempts + (hasToken ? 1 : 0),
          );
      try {
        const run = currentRun(pending);
        if (!run) {
          remove();
          continue;
        }
        // A disconnected account may be reconnected before the next pass.
        if (!hasToken) continue;
        const { verifyCreatedPullRequest } = await import("../pr-watches.js");
        await verifyCreatedPullRequest(
          run,
          {
            owner: pending.repo_owner,
            repo: pending.repo_name,
            number: pending.number,
          },
          () => Boolean(currentRun(pending)),
        );
        remove();
      } catch (error) {
        // Keep only verification intent, with bounded backoff and GitHub's
        // rate-limit deadline. No shell output, credentials or command replay.
        const backoff = Math.min(
          RETRY_MS * 2 ** Math.min(pending.attempts, 6),
          3600_000,
        );
        db.prepare(
          `UPDATE pr_watch_registrations SET next_attempt_at=?
        WHERE run_id=? AND external_id=? AND attempts=?`,
        ).run(
          Math.max(
            time + backoff,
            error instanceof GithubError ? (error.retryAt ?? 0) : 0,
          ),
          pending.run_id,
          pending.external_id,
          pending.attempts + (hasToken ? 1 : 0),
        );
      }
    }
  } finally {
    polling = false;
  }
}
