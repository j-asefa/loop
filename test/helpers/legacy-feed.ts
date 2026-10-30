// Permanent pre-projection Feed oracle. Its SQL and presentation are retained
// from mobile-return.ts before PR 9b; only the retired trigger-maintained columns
// are derived from raw history here. Never read feed_cards or its renderer.
import { z } from "zod";
import { db, now } from "../../src/server/db.js";
import { ownedAgent, ownedFolder, Problem } from "../../src/server/domain.js";
import { projectFolders } from "../../src/server/results.js";
import { unreadCount } from "../../src/server/news.js";
import { nonemptyAnswer } from "../../src/server/feed-answers.js";
import { checkoutSummary } from "../../src/server/run-checkouts.js";
import { verificationSummary } from "../../src/server/run-verifications.js";
import { pullStatus } from "../../src/server/pr-watches.js";
import { runPreview } from "../../src/server/run-attention.js";
import { NATIVE_CONNECTION_SQL } from "../../src/server/native-connections.js";
import { FEED_FILTERS, type FeedPage } from "../../src/shared/workspace-api.js";
import type { QueryRow } from "../../src/server/query-records.js";
import type { Run } from "../../src/server/queue.js";

// Predicates for the thread Feed. `c` is
// an owner-scoped conversation; @now is the read's single observation time.
export const feedRunNeeds = `(c.feed_run_state IN ('awaiting_approval','paused') OR (c.feed_run_raw_state IN ('failed','interrupted') AND c.feed_run_dismissed_at IS NULL))`;
export const feedNeeds = `(${feedRunNeeds} OR COALESCE(c.feed_approval_until,0)>@now)`;
export const feedWorking = `c.feed_run_state IN ('running','pausing','waiting_children')`;

const collapse = (text: string | null | undefined, max: number) =>
  (text || "").replace(/\s+/g, " ").trim().slice(0, max);
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function decode<T>(value: string, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new Problem(400, `Invalid ${label} cursor`);
  }
}

// Top-level named projects keep their existing grouping. Workspace covers only
// unassigned work and ordinary folders outside an explicit project.
const FOLDER_PROJECT = `folder_project(id,project_id) AS (
  SELECT id,id FROM folders WHERE owner_id=@owner AND kind='project' AND parent_id IS NULL
  UNION
  SELECT folder_id,project_id FROM project_change_folders
    WHERE owner_id=@owner AND project_id=(SELECT project_id FROM workspace_projects WHERE owner_id=@owner)
  UNION
  SELECT f.id,p.project_id FROM folders f JOIN folder_project p ON f.parent_id=p.id
    WHERE f.owner_id=@owner AND p.project_id IS NOT (SELECT project_id FROM workspace_projects WHERE owner_id=@owner)
)`;
const current = `FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id ORDER BY CASE WHEN r.state IN ('running','pausing','paused','awaiting_approval') THEN 0 ELSE 1 END,r.created_at DESC,r.rowid DESC LIMIT 1`;
const oracleConversations = `oracle_conversations AS (SELECT
  c.id,c.owner_id,c.title,c.agent_id,c.execution_connection_id,c.team_id,c.origin,c.created_at,c.project_id,
  (SELECT r.id ${current}) feed_run_id,
  (SELECT r.state ${current}) feed_run_raw_state,
  (SELECT CASE WHEN r.state IN ('running','pausing') AND r.worker_id IS NULL THEN 'waiting_children' ELSE r.state END ${current}) feed_run_state,
  (SELECT r.attention_dismissed_at ${current}) feed_run_dismissed_at,
  (SELECT count(*) FROM runs q WHERE q.owner_id=c.owner_id AND q.conversation_id=c.id AND q.state='queued') feed_queued,
  (SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1) feed_done_run_id,
  (SELECT max(r.updated_at) FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed') feed_done_at,
  max(c.created_at,
    COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id),0),
    COALESCE((SELECT max(r.updated_at) FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id),0)) feed_last_activity_at,
  (SELECT m.id FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) feed_last_message_id,
  COALESCE(c.project_id,(SELECT json_extract(fr.payload,'$.folderId') FROM runs fr WHERE fr.owner_id=c.owner_id AND fr.conversation_id=c.id ORDER BY fr.created_at DESC,fr.rowid DESC LIMIT 1)) feed_folder_id,
  (EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id)) feed_visible,
  (SELECT max(a.expires_at) FROM approvals a JOIN runs ar ON ar.id=a.run_id AND ar.owner_id=a.owner_id WHERE a.owner_id=c.owner_id AND ar.conversation_id=c.id AND a.state='pending') feed_approval_until
FROM conversations c WHERE c.owner_id=@owner)`;

type FeedRow = {
  conversation_id: string;
  title: string;
  agent_id: string | null;
  execution_connection_id: string | null;
  team_id: string | null;
  origin: string;
  folder_id: string | null;
  run_id: string | null;
  done_run_id: string | null;
  done_message_id: string | null;
  done_card_key: string;
  last_activity_at: number;
  sort_at: number;
  position_message_id: string | null;
  later_id: string | null;
  pending_approvals: number;
  agent_name: string | null;
  provider: string | null;
  project_id: string | null;
  project_name: string | null;
  card_run: string | null;
  card_run_state: string | null;
  card_run_error: string | null;
  card_run_input: string | null;
  card_run_connection_id: string | null;
  card_run_model: string | null;
  card_run_resolved_model: string | null;
  card_run_created_at: number | null;
  card_run_updated_at: number | null;
  message_id: string | null;
  message_role: string | null;
  message_content: string | null;
  message_metadata: string | null;
  message_created_at: number | null;
  message_automation: string | null;
  message_automation_from: string | null;
  message_saved: number;
  trigger_automation: string | null;
  trigger_automation_from: string | null;
  card_answer_id: string | null;
  approval_id: string | null;
  approval_run_id: string | null;
  approval_message_id: string | null;
  decision_id: string | null;
  decision_run_id: string | null;
  decision_request: string | null;
  later_due_at: number | null;
  later_condition: string | null;
  later_surfaced_at: number | null;
  queued: number;
};

// The state each filter reads, for every visible conversation in scope.
function feedSql(
  teams: boolean,
  folders: boolean,
  agent = false,
  results = false,
) {
  // Done expands a thread into final answers and imported answers. A native
  // run can finish with only commentary; that is not a completed result.
  // Threads without results retain their idle fallback. Other views and counts
  // still read one row per conversation.
  const doneRun = results ? "completed.run_id" : "c.feed_done_run_id";
  const doneAt = results ? "completed.done_at" : "c.feed_done_at";
  // Explicit null means Workspace. Only old snapshots without a folder key
  // inherit the conversation's project.
  const folder = results
    ? "CASE WHEN completed.card_key IS NOT NULL THEN CASE WHEN completed.has_folder THEN completed.folder_id ELSE c.project_id END ELSE c.feed_folder_id END"
    : "c.feed_folder_id";
  return `WITH RECURSIVE ${FOLDER_PROJECT},${oracleConversations},
${
  results
    ? `completed_results AS (
  SELECT r.conversation_id,r.id run_id,NULL message_id,r.updated_at done_at,'run:'||r.id card_key,
    json_extract(r.payload,'$.folderId') folder_id,json_type(r.payload,'$.folderId') IS NOT NULL has_folder
  FROM runs r WHERE r.owner_id=@owner AND r.state='completed'
    AND EXISTS(SELECT 1 FROM messages m INDEXED BY messages_feed_answers WHERE m.owner_id=r.owner_id AND m.conversation_id=r.conversation_id
      AND m.run_id=r.id AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 AND ${nonemptyAnswer("m.content")})
  UNION ALL
  SELECT conversation_id,NULL,id,created_at,'message:'||id,NULL,0
  FROM messages INDEXED BY messages_feed_answers WHERE owner_id=@owner AND run_id IS NULL AND role='assistant'
    AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND ${nonemptyAnswer("content")}
),`
    : ""
}
flagged AS (
  SELECT c.id conversation_id,c.title,c.agent_id,c.execution_connection_id,c.team_id,c.origin,
    ${folder} folder_id,c.feed_run_id run_id,c.feed_run_state run_state,${doneRun} done_run_id,${doneAt} done_at,
    ${results ? "completed.message_id" : "NULL"} done_message_id,
    ${results ? 1 : 0} expanded_done,
    c.feed_last_activity_at last_activity_at,c.feed_queued queued,cp.position_message_id,
    (SELECT l.id FROM later_items l WHERE l.owner_id=c.owner_id AND l.kind='conversation' AND l.target_id=c.id AND l.done_at IS NULL) later_id,
    EXISTS(SELECT 1 FROM later_items l WHERE l.owner_id=c.owner_id AND l.kind='conversation' AND l.target_id=c.id AND l.done_at IS NULL AND l.surfaced_at IS NULL) snoozed,
    c.feed_queued>0 has_queued,
    COALESCE(${results ? "completed.card_key," : ""}'run:'||c.feed_done_run_id,'message:'||c.feed_last_message_id,'run:'||c.feed_run_id) done_card_key,
    ${feedNeeds} is_needs,
    (${feedWorking}) is_working,
    (c.feed_run_raw_state='completed') is_done
  FROM oracle_conversations c
  ${results ? "LEFT JOIN completed_results completed ON completed.conversation_id=c.id" : ""}
  LEFT JOIN conversation_positions cp ON cp.owner_id=c.owner_id AND cp.conversation_id=c.id
  WHERE c.owner_id=@owner AND c.feed_visible=1
    ${teams ? "AND c.team_id IN (SELECT value FROM json_each(@teams))" : ""}
    ${agent ? "AND c.agent_id=@agent" : ""}
    ${folders ? `AND EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS (${folder}))` : ""}
)`;
}

// What a card shows, for the page's conversations only. "done" cards show the
// selected finished run; others show the current run.
const assistantAnswer = (run: string) =>
  `(SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=${run} AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 AND ${nonemptyAnswer("m.content")} ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1)`;
const cardSql = (doneOnly = false) => `
page_run AS MATERIALIZED (
  SELECT p.*,CASE WHEN @mode='done' THEN p.done_run_id ELSE p.run_id END card_run FROM page p
),
picked AS MATERIALIZED (
  SELECT k.*,r.id card_run_id,
    CASE WHEN r.state IN ('running','pausing') AND r.worker_id IS NULL THEN 'waiting_children' ELSE r.state END card_run_state,
    r.error card_run_error,r.input card_run_input,
    json_extract(r.payload,'$.connectionId') card_run_connection_id,json_extract(r.payload,'$.model') card_run_model,
    json_extract(r.payload,'$.resolvedModel') card_run_resolved_model,r.created_at card_run_created_at,r.updated_at card_run_updated_at,
    CASE WHEN k.card_run IS NOT NULL THEN ${assistantAnswer("k.card_run")} END card_answer_id,
    ${doneOnly ? "NULL" : `(SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=k.card_run ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1)`} card_any_id,
    -- Expanded Done selects its answer explicitly. An idle thread without a
    -- result has no preview, rather than showing its prompt or commentary.
    (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id
      AND k.expanded_done=0
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) thread_latest_id,
    CASE WHEN r.id IS NOT NULL THEN (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=r.id AND m.role='user' AND json_extract(m.metadata,'$.automation.kind') IS NOT NULL ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) END trigger_id,
    CASE WHEN @mode='done' THEN 0 ELSE (SELECT count(*) FROM approvals a JOIN runs ar ON ar.id=a.run_id AND ar.owner_id=a.owner_id
      WHERE a.owner_id=@owner AND ar.conversation_id=k.conversation_id AND ar.state='awaiting_approval' AND a.state='pending' AND a.expires_at>@now) END pending_approvals,
    CASE WHEN @mode='done' THEN NULL ELSE (SELECT a.id FROM approvals a JOIN runs ar ON ar.id=a.run_id AND ar.owner_id=a.owner_id
      WHERE a.owner_id=@owner AND ar.conversation_id=k.conversation_id AND ar.state='awaiting_approval' AND a.state='pending' AND a.expires_at>@now ORDER BY a.created_at,a.rowid LIMIT 1) END approval_id,
    CASE WHEN @mode='done' THEN NULL ELSE (SELECT d.id FROM native_decisions d JOIN runs dr ON dr.id=d.run_id AND dr.owner_id=@owner
      WHERE d.conversation_id=k.conversation_id AND dr.state='awaiting_approval' AND d.state='pending' ORDER BY d.created_at LIMIT 1) END decision_id
  FROM page_run k LEFT JOIN runs r ON r.id=k.card_run AND r.owner_id=@owner
),
chosen AS MATERIALIZED (
  SELECT k.*,ap.run_id approval_run_id,
    CASE
      WHEN @mode='done' AND k.done_message_id IS NOT NULL THEN k.done_message_id
      WHEN @mode='done' AND k.card_run IS NOT NULL THEN COALESCE(k.card_answer_id,k.card_any_id)
      WHEN k.card_run IS NOT NULL AND (@mode='working' OR (@mode='thread' AND k.card_run_state IN ('running','pausing','waiting_children'))) THEN k.card_answer_id
      ELSE k.thread_latest_id
    END message_id,
    ${
      doneOnly
        ? "NULL"
        : `COALESCE(
      (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=ap.run_id AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
      (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=ap.run_id AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at,m.rowid LIMIT 1)
    )`
    } approval_message_id
  FROM picked k LEFT JOIN approvals ap ON ap.id=k.approval_id AND ap.owner_id=@owner
)
SELECT k.*,g.name agent_name,g.provider,pf.id project_id,pf.name project_name,
  m.metadata message_metadata,m.role message_role,${doneOnly ? "m.content" : "substr(m.content,1,1000)"} message_content,m.created_at message_created_at,
  json_extract(m.metadata,'$.automation.kind') message_automation,json_extract(m.metadata,'$.automation.fromName') message_automation_from,
  (m.id IS NOT NULL AND (EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.owner_id=@owner AND b.message_id=m.id)
    OR EXISTS(SELECT 1 FROM artifacts sa WHERE sa.owner_id=@owner AND sa.pinned=1 AND sa.archived=0 AND json_extract(sa.metadata,'$.messageId')=m.id))) message_saved,
  json_extract(t.metadata,'$.automation.kind') trigger_automation,json_extract(t.metadata,'$.automation.fromName') trigger_automation_from,
  d.run_id decision_run_id,d.request decision_request,
  l.due_at later_due_at,l.condition later_condition,l.surfaced_at later_surfaced_at
FROM chosen k
LEFT JOIN agents g ON g.id=k.agent_id AND g.owner_id=@owner
LEFT JOIN folder_project fp ON fp.id IS k.folder_id
LEFT JOIN folders pf ON pf.id=fp.project_id AND pf.owner_id=@owner
LEFT JOIN messages m ON m.id=k.message_id
LEFT JOIN messages t ON t.id=k.trigger_id
LEFT JOIN native_decisions d ON d.id=k.decision_id
LEFT JOIN later_items l ON l.id=k.later_id AND l.owner_id=@owner
ORDER BY k.sort_at DESC,k.conversation_id DESC,k.done_card_key DESC`;

function readFeed(
  owner: string,
  options: {
    filter?: (typeof FEED_FILTERS)[number];
    expand?: "results";
    folder?: string;
    teams?: string[];
    agent?: string;
    before?: string;
  },
): FeedPage {
  if (options.agent) ownedAgent(options.agent, owner);
  const filter = options.filter || "all";
  // Older open tabs key and paginate by conversation. Only clients that
  // understand independent result identities opt into the expanded collection.
  const results = filter === "done" && options.expand === "results";
  const teams = options.teams?.length ? options.teams : undefined;
  let folders: (string | null)[] | undefined;
  if (options.folder) {
    ownedFolder(options.folder, owner);
    folders = projectFolders(owner, options.folder);
  }
  const cursor = options.before
    ? decode(
        options.before,
        z.tuple([
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z.string().min(1).max(150),
          // Older cursors contain only a time and conversation. New Done
          // cursors also distinguish results that finished at the same time.
          z.string().min(1).max(200).optional(),
        ]),
        "feed",
      )
    : undefined;
  const mode =
    filter === "done" ? "done" : filter === "working" ? "working" : "thread";
  const params = {
    owner,
    now: now(),
    mode,
    teams: teams ? JSON.stringify(teams) : null,
    folders: folders ? JSON.stringify(folders) : null,
    agent: options.agent ?? null,
    at: cursor?.[0] ?? null,
    after: cursor?.[1] ?? null,
    afterCard: cursor?.[2] ?? null,
  };
  const replyPage = filter === "replies" ? readReplyFeed(params) : undefined;
  const sql = feedSql(!!teams, !!folders, !!options.agent);
  const where = {
    replies: "0",
    all: "NOT snoozed",
    // Completed results remain until individually dismissed, including when
    // newer work finishes or the conversation is snoozed. Threads without a
    // result keep their existing idle/snoozed behavior.
    done: `${
      results
        ? "(done_run_id IS NOT NULL OR done_message_id IS NOT NULL OR (NOT (COALESCE(is_needs,0) OR COALESCE(is_working,0) OR has_queued) AND NOT snoozed))"
        : "(done_run_id IS NOT NULL OR NOT (COALESCE(is_needs,0) OR COALESCE(is_working,0) OR has_queued)) AND NOT snoozed"
    }
      AND NOT EXISTS(SELECT 1 FROM done_card_dismissals d WHERE d.owner_id=@owner AND d.conversation_id=flagged.conversation_id AND d.card_key=flagged.done_card_key)`,
    needs: "is_needs",
    working: "is_working",
    queued: "has_queued",
    later: "snoozed",
    outcomes: "is_done AND NOT snoozed",
    unfinished: "(is_needs OR is_working OR has_queued) AND NOT snoozed",
  }[filter];
  // This is a result-card preference, not a conversation or agent mute.
  // Explicit team and agent views retain history; attention and live work
  // stay visible. Apply before pagination, without changing activity counts.
  const teamVisibility =
    !teams && !options.agent && (filter === "done" || filter === "outcomes")
      ? "AND NOT EXISTS(SELECT 1 FROM teams t WHERE t.id=flagged.team_id AND t.owner_id=@owner AND t.deleted_at IS NULL AND t.hide_results_from_feed=1)"
      : "";
  // Done lists outputs by when they finished, so a follow-up does not move them.
  const sortAt =
    filter === "done"
      ? "COALESCE(done_at,last_activity_at)"
      : "last_activity_at";
  // A legacy Done cursor cannot identify the result at its boundary. Replay
  // that conversation's tied results once; clients deduplicate by card key and
  // every continuation now carries the exact result. Other views stay exclusive.
  const afterCard = results
    ? "(@afterCard IS NULL OR done_card_key<@afterCard)"
    : "done_card_key<@afterCard";
  const rows = db
    .prepare(
      `${results ? feedSql(!!teams, !!folders, !!options.agent, true) : sql},
page AS MATERIALIZED (
  SELECT *,${sortAt} sort_at FROM flagged WHERE ${where} ${teamVisibility}
    AND (@at IS NULL OR ${sortAt}<@at OR (${sortAt}=@at AND (conversation_id<@after OR (conversation_id=@after AND ${afterCard}))))
  ORDER BY sort_at DESC,conversation_id DESC,done_card_key DESC LIMIT 41
),${cardSql()}`,
    )
    .all(params) as FeedRow[];
  const more = rows.length > 40;
  if (more) rows.pop();
  // Dismissing a Done card changes neither run state nor any activity count.
  const summary = db
    .prepare(
      `${sql} SELECT COALESCE(sum(is_needs),0) needs,COALESCE(sum(is_working),0) working,
      COALESCE(sum(has_queued),0) queued FROM flagged`,
    )
    .get(params) as Record<string, number>;
  // Unread completed results in Done, with Done's team visibility, from history.
  const doneUnread = db
    .prepare(
      `${feedSql(!!teams, !!folders, !!options.agent, true)} SELECT count(*) n FROM flagged
      WHERE (done_run_id IS NOT NULL OR done_message_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM done_card_dismissals d WHERE d.owner_id=@owner AND d.conversation_id=flagged.conversation_id AND d.card_key=flagged.done_card_key)
        AND NOT EXISTS(SELECT 1 FROM done_card_reads d WHERE d.owner_id=@owner AND d.conversation_id=flagged.conversation_id AND d.card_key=flagged.done_card_key)
        ${!teams && !options.agent ? "AND NOT EXISTS(SELECT 1 FROM teams t WHERE t.id=flagged.team_id AND t.owner_id=@owner AND t.deleted_at IS NULL AND t.hide_results_from_feed=1)" : ""}`,
    )
    .get(params) as { n: number };
  const laterDue = db
    .prepare(
      "SELECT count(*) n FROM later_items WHERE owner_id=? AND surfaced_at IS NOT NULL AND done_at IS NULL",
    )
    .get(owner) as { n: number };
  // Scheduled messages, owner-wide: not sent (needs you) apart from waiting.
  const scheduled = db
    .prepare(
      "SELECT COALESCE(sum(state='failed'),0) failed,COALESCE(sum(state='scheduled'),0) pending FROM scheduled_sends WHERE owner_id=?",
    )
    .get(owner) as { failed: number; pending: number };
  const last = rows.at(-1);
  return {
    items: replyPage
      ? replyPage.items
      : rows.map((row) => feedItem(owner, row, mode)),
    next: replyPage
      ? replyPage.next
      : more && last
        ? encode(
            results
              ? [last.sort_at, last.conversation_id, last.done_card_key]
              : [last.sort_at, last.conversation_id],
          )
        : null,
    summary: {
      needs: summary.needs,
      working: summary.working,
      queued: summary.queued,
      replies_unread: replyUnread(params),
      done_unread: doneUnread.n,
      later_due: laterDue.n,
      social_unread: unreadCount(owner),
      scheduled_failed: scheduled.failed,
      scheduled_pending: scheduled.pending,
    },
  };
}

function projectFor(owner: string, folder: string | null | undefined) {
  return (
    (db
      .prepare(
        `WITH RECURSIVE ${FOLDER_PROJECT} SELECT p.id,p.name FROM folder_project fp JOIN folders p ON p.id=fp.project_id AND p.owner_id=@owner WHERE fp.id IS @folder`,
      )
      .get({ owner, folder: folder ?? null }) as
      { id: string; name: string } | undefined) || null
  );
}

type ReplyScope = {
  owner: string;
  teams: string | null;
  folders: string | null;
  agent: string | null;
};
const replyFolder =
  "CASE WHEN json_type(r.payload,'$.folderId') IS NOT NULL THEN json_extract(r.payload,'$.folderId') ELSE c.project_id END";
const replyScopeSql = `FROM steering_replies p
  JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
  JOIN run_steering s ON s.id=p.steering_id AND s.owner_id=p.owner_id
  JOIN messages q ON q.id=s.message_id AND q.owner_id=p.owner_id
  JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=p.owner_id
  JOIN runs r ON r.id=m.run_id AND r.owner_id=p.owner_id
  WHERE p.owner_id=@owner AND p.archived_at IS NULL
    AND (@teams IS NULL OR c.team_id IN (SELECT value FROM json_each(@teams)))
    AND (@agent IS NULL OR r.agent_id=@agent)
    AND (@folders IS NULL OR ${replyFolder} IN (SELECT value FROM json_each(@folders))
      OR (${replyFolder} IS NULL AND EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS NULL)))`;

function replyUnread(scope: ReplyScope) {
  return (
    db
      .prepare(`SELECT count(*) n ${replyScopeSql} AND p.read_at IS NULL`)
      .get(scope) as { n: number }
  ).n;
}

function readReplyFeed(
  scope: ReplyScope & {
    at: number | null;
    after: string | null;
    afterCard: string | null;
  },
) {
  const rows = db
    .prepare(
      `SELECT p.message_id,p.created_at,p.read_at,q.id question_id,substr(q.content,1,1000) question,
    substr(m.content,1,1000) content,c.id conversation_id,c.title,c.origin,c.team_id,r.agent_id,
    ${replyFolder} folder_id,r.id run_id,r.state,r.error,r.input,r.created_at run_created_at,r.updated_at,
    json_extract(r.payload,'$.connectionId') connection_id,json_extract(r.payload,'$.model') model,
    json_extract(r.payload,'$.resolvedModel') resolved_model,json_extract(r.payload,'$.provider') provider,
    COALESCE(json_extract(r.payload,'$.name'),(SELECT name FROM agents WHERE id=r.agent_id AND owner_id=@owner)) agent_name,
    EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.owner_id=@owner AND b.message_id=m.id) saved
    ${replyScopeSql}
      AND (@at IS NULL OR (p.created_at,c.id,'reply:'||p.message_id)<(@at,@after,@afterCard))
    ORDER BY p.created_at DESC,c.id DESC,p.message_id DESC LIMIT 41`,
    )
    .all(scope) as {
    message_id: string;
    created_at: number;
    read_at: number | null;
    question_id: string;
    question: string;
    content: string;
    conversation_id: string;
    title: string;
    origin: string;
    team_id: string | null;
    agent_id: string | null;
    folder_id: string | null;
    run_id: string;
    state: string;
    error: string | null;
    input: string;
    run_created_at: number;
    updated_at: number;
    connection_id: string | null;
    model: string | null;
    resolved_model: string | null;
    provider: string | null;
    agent_name: string | null;
    saved: number;
  }[];
  const more = rows.length > 40;
  if (more) rows.pop();
  const last = rows.at(-1);
  return {
    items: rows.map((row) => {
      const project = projectFor(scope.owner, row.folder_id);
      return {
        conversation_id: row.conversation_id,
        reply_card_key: `reply:${row.message_id}`,
        reply: {
          message_id: row.question_id,
          content: row.question,
          read_at: row.read_at,
        },
        title: collapse(row.question, 200) || row.title,
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        provider: row.provider,
        connection_id: row.connection_id,
        project_id: project?.id ?? null,
        project_name: project?.name ?? null,
        team_id: row.team_id,
        origin: row.origin,
        last_activity_at: row.created_at,
        last_message: {
          id: row.message_id,
          role: "assistant",
          preview: row.content,
          created_at: row.created_at,
          saved: !!row.saved,
        },
        run: {
          id: row.run_id,
          state: row.state,
          error: row.error,
          input: row.input,
          connection_id: row.connection_id,
          model: row.model,
          resolved_model: row.resolved_model,
          created_at: row.run_created_at,
          updated_at: row.updated_at,
          queue_position: null,
        },
        pending_approvals: 0,
        position_message_id: null,
        later: null,
        next_action: null,
      };
    }),
    next:
      more && last
        ? encode([
            last.created_at,
            last.conversation_id,
            `reply:${last.message_id}`,
          ])
        : null,
  };
}

export function feed(owner: string, options: Parameters<typeof readFeed>[1]) {
  return readFeed(owner, options);
}

/** Shared Done projection: keeps the legacy feed's exact membership and identity. */
export function doneCardRows(
  owner: string,
  options: {
    folders: (string | null)[] | null;
    teamIds: string[];
    agent?: string;
    before?: [number, string] | null;
    ids?: string[];
    limit: number;
    detail?: boolean;
    atTime?: number;
  },
) {
  if (options.ids && !options.ids.length) return [];
  const identity = "'d:'||COALESCE(done_card_key,'idle:'||conversation_id)";
  const order = "conversation_id||char(31)||COALESCE(done_card_key,'')";
  const rows = db
    .prepare(
      `${feedSql(!!options.teamIds.length, !!options.folders, !!options.agent, true)},
    page AS MATERIALIZED (
      SELECT *,COALESCE(done_at,last_activity_at) sort_at FROM flagged
      WHERE (done_run_id IS NOT NULL OR done_message_id IS NOT NULL OR
        (NOT (COALESCE(is_needs,0) OR COALESCE(is_working,0) OR has_queued) AND NOT snoozed))
        AND NOT EXISTS(SELECT 1 FROM done_card_dismissals d WHERE d.owner_id=@owner
          AND d.conversation_id=flagged.conversation_id AND d.card_key=flagged.done_card_key)
        ${!options.detail && !options.teamIds.length && !options.agent ? "AND NOT EXISTS(SELECT 1 FROM teams t WHERE t.id=flagged.team_id AND t.owner_id=@owner AND t.deleted_at IS NULL AND t.hide_results_from_feed=1)" : ""}
        AND (@ids IS NULL OR ${identity} IN (SELECT value FROM json_each(@ids)))
        AND (@at IS NULL OR (COALESCE(done_at,last_activity_at),${order})<(@at,@key))
      ORDER BY sort_at DESC,conversation_id DESC,done_card_key DESC LIMIT @limit
    ),${cardSql(true)}`,
    )
    .all({
      owner,
      now: options.atTime ?? now(),
      mode: "done",
      teams: options.teamIds.length ? JSON.stringify(options.teamIds) : null,
      folders: options.folders ? JSON.stringify(options.folders) : null,
      agent: options.agent ?? null,
      ids: options.ids ? JSON.stringify(options.ids) : null,
      at: options.before?.[0] ?? null,
      key: options.before?.[1] ?? null,
      limit: options.limit,
    }) as FeedRow[];
  return rows.map((row) => {
    const display = feedItem(owner, row, "done");
    if (display.last_message)
      display.last_message.content = row.message_content!;
    const result = row.done_run_id !== null || row.done_message_id !== null;
    const read = db
      .prepare(
        "SELECT read_at FROM done_card_reads WHERE owner_id=? AND conversation_id=? AND card_key=?",
      )
      .get(owner, row.conversation_id, row.done_card_key) as
      { read_at: number } | undefined;
    return {
      row,
      display,
      read_at: result ? (read?.read_at ?? null) : undefined,
    };
  });
}

function queuePosition(runId: string) {
  return (
    db
      .prepare(
        `SELECT (SELECT count(*)+1 FROM runs older WHERE older.agent_id=r.agent_id AND older.state IN ('queued','running','pausing','paused','awaiting_approval')
        AND (COALESCE(older.queue_rank,older.created_at)<COALESCE(r.queue_rank,r.created_at) OR (COALESCE(older.queue_rank,older.created_at)=COALESCE(r.queue_rank,r.created_at) AND older.rowid<r.rowid))) position
        FROM runs r WHERE r.id=?`,
      )
      .get(runId) as { position: number }
  ).position;
}

// Queued runs a reorder can swap with. Same scope as the queue claim: one
// agent, and one conversation when both runs use a per-conversation (native)
// connection. Running, paused and approval-waiting work never moves.
function queuedPeers(owner: string, runId: string) {
  const run = db
    .prepare(
      `SELECT r.agent_id,r.conversation_id,${perConversation("r")} per FROM runs r WHERE r.id=? AND r.owner_id=?`,
    )
    .get(runId, owner) as
    | { agent_id: string | null; conversation_id: string | null; per: number }
    | undefined;
  if (!run?.agent_id) return [];
  const per = run.per;
  return db
    .prepare(
      `SELECT r.id,r.conversation_id,COALESCE(r.queue_rank,r.created_at) queue_key FROM runs r
      WHERE r.owner_id=@owner AND r.agent_id=@agent AND r.state='queued'
        AND (r.conversation_id=@conversation OR NOT @per OR NOT ${perConversation("r")})
      ORDER BY COALESCE(r.queue_rank,r.created_at),r.rowid`,
    )
    .all({
      owner,
      agent: run.agent_id,
      conversation: run.conversation_id,
      per,
    }) as { id: string; conversation_id: string | null; queue_key: number }[];
}
// A swap only crosses threads: each conversation's turns run in the order
// they were sent, because its model history is built in that order.
function canSwap(
  peers: { id: string; conversation_id: string | null }[],
  index: number,
  other: number,
) {
  return (
    index >= 0 &&
    other >= 0 &&
    other < peers.length &&
    peers[other].conversation_id !== peers[index].conversation_id
  );
}
function queueMoves(owner: string, runId: string) {
  const peers = queuedPeers(owner, runId);
  const index = peers.findIndex((peer) => peer.id === runId);
  return {
    can_move_up: canSwap(peers, index, index - 1),
    can_move_down: canSwap(peers, index, index + 1),
  };
}

/**
 * "done" shows one completed result, independently of the work after it;
 * "working" shows only what the current run has produced; "thread" shows
 * the thread as it is now. Everything but live previews and queue positions
 * arrives with the page.
 */
function feedItem(
  owner: string,
  row: FeedRow,
  mode: "thread" | "done" | "working" = "thread",
) {
  const run = row.card_run_state
    ? {
        id: row.card_run!,
        state: row.card_run_state,
        error: row.card_run_error,
        input: row.card_run_input!,
        connection_id: row.card_run_connection_id,
        model: row.card_run_model,
        resolved_model: row.card_run_resolved_model,
        created_at: row.card_run_created_at!,
        updated_at: row.card_run_updated_at!,
      }
    : undefined;
  const message = row.message_id
    ? {
        id: row.message_id,
        role: row.message_role!,
        content: row.message_content!,
        created_at: row.message_created_at!,
        automation: row.message_automation,
        automation_from: row.message_automation_from,
      }
    : undefined;
  // The prompt is hidden while its run works, so keep who started it: a
  // watched pull request or a teammate agent rather than you.
  const trigger =
    run && message?.role !== "user"
      ? {
          automation: row.trigger_automation,
          automation_from: row.trigger_automation_from,
        }
      : undefined;
  return {
    conversation_id: row.conversation_id,
    ...(mode === "done" ? { done_card_key: row.done_card_key } : {}),
    // The thread keeps the title from its first prompt, but a card is named
    // by the prompt of the run it shows: a Done card by the prompt its answer
    // replies to, a Working card by the task in progress. Imported history
    // has no runs and keeps the thread title.
    title: (run && collapse(run.input, 200)) || row.title,
    agent_id: row.agent_id,
    connection_id: row.execution_connection_id,
    agent_name: row.agent_name ?? null,
    provider: row.provider ?? null,
    project_id: row.folder_id ? (row.project_id ?? null) : null,
    project_name: row.folder_id ? (row.project_name ?? null) : null,
    team_id: row.team_id,
    origin: row.origin,
    last_activity_at: mode === "done" ? row.sort_at : row.last_activity_at,
    last_message: message
      ? {
          id: message.id,
          role: message.role,
          preview: collapse(message.content, 200),
          // Markdown for full-size Feed cards; the card clips it visually.
          content: message.content.slice(0, 4000),
          created_at: message.created_at,
          // So the card's menu offers Save or Remove from Saved, as the
          // thread and the result card already do.
          saved: !!row.message_saved,
          // Sent by Loop55 for you (a watched pull request or a teammate
          // agent), not typed by you.
          ...(message.automation ? { automation: message.automation } : {}),
          ...(message.automation_from
            ? { automation_from: message.automation_from }
            : {}),
        }
      : null,
    run: run
      ? {
          ...run,
          input: run.input.slice(0, 1000),
          // What Loop55 observed in the agent's worktree. Absent for API agents
          // and for runs that have not started, so those cards are unchanged.
          ...(() => {
            const checkout = checkoutSummary(owner, run.id);
            const verification = verificationSummary(owner, run.id);
            return {
              ...(checkout ? { checkout } : {}),
              ...(verification ? { verification } : {}),
            };
          })(),
          ...(trigger?.automation
            ? {
                automation: trigger.automation,
                automation_from: trigger.automation_from,
              }
            : {}),
          queue_position: run.state === "queued" ? queuePosition(run.id) : null,
          ...(run.state === "queued"
            ? queueMoves(owner, run.id)
            : { can_move_up: false, can_move_down: false }),
        }
      : null,
    // Queued follow-ups, listed separately so they stay manageable while
    // the thread's current run is still working.
    // The thread's pull request as its watch last saw it. Null says there
    // is none; a response without the key comes from a server that does not
    // report it, and the client treats that as unknown.
    pull: pullStatus(owner, row.conversation_id),
    queued_runs: (mode === "done" || !row.queued
      ? []
      : (db
          .prepare(
            "SELECT id,input,created_at,state,worker_id,active_since FROM runs WHERE owner_id=? AND conversation_id=? AND state='queued' ORDER BY COALESCE(queue_rank,created_at),rowid LIMIT 5",
          )
          .all(owner, row.conversation_id) as QueuedRun[])
    ).map((queued) => ({
      id: queued.id,
      // The full text: the editor saves exactly what it shows, so a preview
      // here would silently truncate a long prompt.
      input: queued.input,
      created_at: queued.created_at,
      queue_position: queuePosition(queued.id),
      can_edit: editable(queued),
      ...queueMoves(owner, queued.id),
    })),
    // While the agent works, its card shows what it has written so far.
    live_preview:
      run &&
      [
        "running",
        "pausing",
        "waiting_children",
        "paused",
        "awaiting_approval",
      ].includes(run.state)
        ? livePreview(owner, run.id)
        : null,
    pending_approvals: mode === "done" ? 0 : row.pending_approvals,
    position_message_id: row.position_message_id,
    later: row.later_id
      ? {
          id: row.later_id,
          due_at: row.later_due_at,
          condition: row.later_condition,
          surfaced_at: row.later_surfaced_at,
        }
      : null,
    next_action: nextAction(row, run, mode === "done"),
  };
}

/**
 * The one specific thing a thread is waiting for, and the message that holds
 * it, so the Feed can open exactly there. An approval appears on its run's
 * last message; a structured question from a native harness is answered at
 * the end of the thread; a finished run opens at its answer. A local draft
 * ("Continue draft") is added by the client. null: only Reply applies.
 */
export type NextAction = {
  kind: "approve" | "answer" | "result";
  message_id: string | null;
  run_id: string;
  ref?: string;
};
function nextAction(
  row: FeedRow,
  run: { id: string; state: string } | undefined,
  // A Done card opens at its answer, whatever the thread waits on now.
  resultOnly: boolean,
): NextAction | null {
  if (!resultOnly && row.approval_run_id)
    return {
      kind: "approve",
      run_id: row.approval_run_id,
      message_id: row.approval_message_id,
    };
  if (!resultOnly && row.decision_run_id) {
    let questions = false;
    try {
      const request = JSON.parse(row.decision_request || "");
      questions =
        Array.isArray(request?.questions) && request.questions.length > 0;
    } catch {}
    // Native decisions are answered at the end of the thread.
    return {
      kind: questions ? "answer" : "approve",
      run_id: row.decision_run_id,
      message_id: null,
    };
  }
  if (run?.state === "completed" && row.card_answer_id)
    return { kind: "result", run_id: run.id, message_id: row.card_answer_id };
  return null;
}

function livePreview(owner: string, runId: string) {
  const { latest, artifact } = runPreview(owner, runId);
  const text = (latest ?? artifact?.content ?? "").trim();
  return text ? text.slice(0, 4000) : null;
}

type QueuedRun = Pick<
  QueryRow<"runs">,
  "id" | "input" | "created_at" | "state" | "worker_id" | "active_since"
>;
const perConversation = (r: string) =>
  `EXISTS(SELECT 1 FROM connections c WHERE c.id=json_extract(${r}.payload,'$.connectionId') AND c.owner_id=${r}.owner_id AND ${NATIVE_CONNECTION_SQL})`;
const RANK_STEP = 1 / 1024;
function editable(
  run: Pick<Run, "id" | "worker_id" | "active_since"> & { state: string },
) {
  return (
    run.state === "queued" &&
    run.worker_id === null &&
    !run.active_since &&
    !db.prepare("SELECT 1 FROM agent_checkpoints WHERE run_id=?").get(run.id) &&
    !db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id)
  );
}
