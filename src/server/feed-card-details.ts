import type Database from "better-sqlite3";
import { summarize, type VerificationItem } from "../shared/verification.js";
import { pullStateFromWatch, type WatchRow } from "../shared/pull-state.js";
import type { FeedCardDetail } from "./feed-card-display.js";
import { NATIVE_CONNECTION_SQL } from "./native-connections.js";

type QueueRun = {
  id: string;
  input: string;
  agent_id: string | null;
  conversation_id: string | null;
  created_at: number;
  state: string;
  worker_id: string | null;
  active_since: number | null;
};
export type ApprovalCandidate = {
  id: string;
  run_id: string;
  message_id: string | null;
  expires_at: number;
};
export type WatchCandidate = WatchRow & {
  updated_at: number;
  created_at: number;
};
export type ThreadDetails = {
  approvals: ApprovalCandidate[];
  watches: WatchCandidate[];
  queued_runs: FeedCardDetail["queued_runs"];
};
const perConversation = (r: string) =>
  `EXISTS(SELECT 1 FROM connections c WHERE c.id=json_extract(${r}.payload,'$.connectionId') AND c.owner_id=${r}.owner_id AND ${NATIVE_CONNECTION_SQL})`;

export function queueDetails(
  db: Database.Database,
  owner: string,
  run: QueueRun,
) {
  const position = db
    .prepare(
      `SELECT (SELECT count(*)+1 FROM runs older WHERE older.agent_id=r.agent_id
    AND older.state IN ('queued','running','pausing','paused','awaiting_approval')
    AND (COALESCE(older.queue_rank,older.created_at)<COALESCE(r.queue_rank,r.created_at)
      OR (COALESCE(older.queue_rank,older.created_at)=COALESCE(r.queue_rank,r.created_at) AND older.rowid<r.rowid))) position
    FROM runs r WHERE r.id=? AND r.owner_id=?`,
    )
    .get(run.id, owner) as { position: number };
  const peers = !run.agent_id
    ? []
    : (db
        .prepare(
          `SELECT r.id,r.conversation_id FROM runs r
    WHERE r.owner_id=@owner AND r.agent_id=@agent AND r.state='queued'
      AND (r.conversation_id=@conversation OR NOT (SELECT ${perConversation("p")} FROM runs p WHERE p.id=@run) OR NOT ${perConversation("r")})
    ORDER BY COALESCE(r.queue_rank,r.created_at),r.rowid`,
        )
        .all({
          owner,
          agent: run.agent_id,
          conversation: run.conversation_id,
          run: run.id,
        }) as { id: string; conversation_id: string | null }[]);
  const index = peers.findIndex((p) => p.id === run.id);
  const swap = (other: number) =>
    index >= 0 &&
    other >= 0 &&
    other < peers.length &&
    peers[other].conversation_id !== peers[index].conversation_id;
  return {
    queue_position: position.position,
    can_move_up: swap(index - 1),
    can_move_down: swap(index + 1),
  };
}

export function threadDetails(
  db: Database.Database,
  owner: string,
  conversation: string,
): ThreadDetails {
  const approvals = db
    .prepare(
      `SELECT a.id,a.run_id,a.expires_at,COALESCE(
    (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=@conversation AND m.run_id=a.run_id AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
    (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=@conversation AND m.run_id=a.run_id AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at,m.rowid LIMIT 1)) message_id
    FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    WHERE a.owner_id=@owner AND r.conversation_id=@conversation AND r.state='awaiting_approval' AND a.state='pending'
    ORDER BY a.created_at,a.rowid`,
    )
    .all({ owner, conversation }) as ApprovalCandidate[];
  const watches = db
    .prepare(
      `SELECT repo_owner,repo_name,number,state,ended_reason,error,head_sha,ci_sha,ci_conclusion,
    ci_pending,read_at,seen_ci_sha,seen_ci_conclusion,updated_at,created_at FROM pr_watches WHERE owner_id=? AND conversation_id=?
    ORDER BY CASE state WHEN 'watching' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,created_at DESC`,
    )
    .all(owner, conversation) as WatchCandidate[];
  const queued = db
    .prepare(
      "SELECT * FROM runs WHERE owner_id=? AND conversation_id=? AND state='queued' ORDER BY COALESCE(queue_rank,created_at),rowid LIMIT 5",
    )
    .all(owner, conversation) as QueueRun[];
  return {
    approvals,
    watches,
    queued_runs: queued.map((run) => ({
      id: run.id,
      input: run.input,
      created_at: run.created_at,
      ...queueDetails(db, owner, run),
      can_edit:
        run.worker_id === null &&
        !run.active_since &&
        !db
          .prepare("SELECT 1 FROM agent_checkpoints WHERE run_id=?")
          .get(run.id) &&
        !db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
    })),
  };
}

export function runDetails(
  db: Database.Database,
  owner: string,
  runId: string | null,
): FeedCardDetail {
  const detail: FeedCardDetail = {
    checkout: null,
    verification: null,
    queue_position: null,
    moves: { can_move_up: false, can_move_down: false },
    pull: null,
    queued_runs: [],
    live_preview: null,
  };
  if (!runId) return detail;
  const run = db
    .prepare("SELECT * FROM runs WHERE id=? AND owner_id=?")
    .get(runId, owner) as QueueRun | undefined;
  if (!run) return detail;
  const checkout = db
    .prepare("SELECT summary FROM run_checkouts WHERE run_id=? AND owner_id=?")
    .get(runId, owner) as { summary: string | null } | undefined;
  detail.checkout = checkout?.summary ? JSON.parse(checkout.summary) : null;
  const verifications = db
    .prepare(
      "SELECT * FROM run_verifications WHERE owner_id=? AND run_id=? ORDER BY observed_at,rowid",
    )
    .all(owner, runId) as (Omit<VerificationItem, "tools" | "truncated"> & {
    tools: string;
    truncated: number;
  })[];
  detail.verification = verifications.length
    ? summarize(
        verifications.map((row) => ({
          id: row.id,
          kind: row.kind,
          tools: JSON.parse(row.tools),
          command: row.command,
          status: row.status,
          exit_code: row.exit_code,
          truncated: !!row.truncated,
          observed_at: row.observed_at,
        })),
      )
    : null;
  if (run.state === "queued") {
    const { queue_position, ...moves } = queueDetails(db, owner, run);
    detail.queue_position = queue_position;
    detail.moves = moves;
  }
  if (
    ["running", "pausing", "paused", "awaiting_approval"].includes(run.state)
  ) {
    const artifact = db
      .prepare(
        `SELECT a.content FROM agent_checkpoints cp JOIN artifacts a ON a.id=cp.artifact_id AND a.owner_id=? JOIN runs r ON r.id=cp.run_id WHERE cp.run_id=?`,
      )
      .get(owner, runId) as { content: string } | undefined;
    const latest = !artifact?.content
      ? (db
          .prepare(
            "SELECT content FROM messages WHERE owner_id=? AND run_id=? AND role='assistant' AND length(trim(content))>0 ORDER BY created_at DESC,rowid DESC LIMIT 1",
          )
          .get(owner, runId) as { content: string } | undefined)
      : undefined;
    detail.live_preview =
      (latest?.content ?? artifact?.content ?? "").trim().slice(0, 4000) ||
      null;
  }
  return detail;
}

export function currentPull(watches: WatchCandidate[], at: number) {
  const watch = watches.find(
    (w) =>
      w.state === "watching" ||
      w.state === "paused" ||
      w.updated_at > at - 7 * 24 * 3600_000,
  );
  return watch ? pullStateFromWatch(watch) : null;
}
