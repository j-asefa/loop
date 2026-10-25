import {
  PositionInput, FeedUpdateInput, SavedLabelInput, LaterInput as laterInput,
  ScheduleInput as scheduleInput, ScheduleUpdateInput, RunReorderInput,
  QueuedRunInput, RunWithdrawInput, RunMoveInput, ConversationForkInput,
} from "../shared/mobile-contract-schemas.js";
import { MessageMetadata, parseMessages } from "./row-schemas.js";
import type { QueryRow } from "./query-records.js";


import { assertFeedApplied, projectionPage, projectionSummary, projectionDoneRows } from "./feed-card-read.js";
import { nonemptyAnswer } from "./feed-answers.js";
import { ensureWorkspaceProject } from "./workspace-project.js";
import { feedNeeds, feedWorking } from "./feed-predicates.js";
import { checkoutSummary } from "./run-checkouts.js";
import { verificationSummary } from "./run-verifications.js";
import { pullStatus } from "./pr-watches.js";
import { z, ZodError } from "zod";
import { db, emit, id, now } from "./db.js";
import { ownedAgent, ownedFolder, ownedConversation, ownedMessage, ownedConnection, ownedRun, owned, Problem } from "./domain.js";
import {
  resultOutputSql,
  fileArtifactSql,
  projectFolders,
  resultUrl,
} from "./results.js";
import { submit } from "./agent-runtime.js";
import { transition, type Run } from "./queue.js";
import { runPreview } from "./run-attention.js";
import { attachedFiles } from "./uploads.js";
import { messageReplyContext } from "./message-replies.js";
import { NATIVE_CONNECTION_SQL } from "./native-connections.js";
import { savedStory, unreadCount } from "./news.js";

import { MAX_MESSAGE_FILES, type UploadedFile } from "../shared/uploads.js";

/**
 * Composer descriptors for files attached to a stored message, in order, read
 * without loading their bytes. Files that no longer exist are left out; the
 * caller compares counts when a missing file must not go unnoticed.
 */
function attachmentDescriptors(owner: string, ids: string[]): UploadedFile[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT a.id,o.id objectId,o.name,o.mime,length(o.bytes) size FROM artifacts a
      JOIN objects o ON o.id=json_extract(a.metadata,'$.objectId') AND o.owner_id=a.owner_id
      WHERE a.owner_id=? AND json_extract(a.metadata,'$.upload') IS NOT NULL AND a.id IN (SELECT value FROM json_each(?))`,
    )
    .all(owner, JSON.stringify(ids)) as UploadedFile[];
  return ids.flatMap((fileId) => rows.filter((row) => row.id === fileId));
}

// Every function here takes the owner from authentication. Rows are always
// selected with that owner, so another owner's ids behave as missing.

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
// A conversation's folder: its recorded project, else its latest run's folder.
const conversationFolder = (c: string) =>
  `COALESCE(${c}.project_id,(SELECT json_extract(fr.payload,'$.folderId') FROM runs fr WHERE fr.owner_id=${c}.owner_id AND fr.conversation_id=${c}.id ORDER BY fr.created_at DESC,fr.rowid DESC LIMIT 1))`;
const ACTIVE_STATES =
  "('queued','running','pausing','paused','awaiting_approval')";
const publicState = (r: string) =>
  `CASE WHEN ${r}.state IN ('running','pausing') AND ${r}.worker_id IS NULL THEN 'waiting_children' ELSE ${r}.state END`;

// ---------------------------------------------------------------------------
// 1. Reading position
// Where you stopped reading a thread, so reopening it continues from there.
function readingPosition(owner: string, conversation: string) {
  return (
    (
      db
        .prepare(
          "SELECT position_message_id FROM conversation_positions WHERE owner_id=? AND conversation_id=?",
        )
        .get(owner, conversation) as
        { position_message_id: string | null } | undefined
    )?.position_message_id ?? null
  );
}

export function conversationReturnState(owner: string, conversation: string) {
  // A reply is saved when it was saved itself or its result card is saved.
  const saved = (
    db
      .prepare(
        `SELECT b.message_id FROM message_bookmarks b JOIN messages m ON m.id=b.message_id AND m.owner_id=b.owner_id WHERE b.owner_id=@owner AND m.conversation_id=@conversation
        UNION SELECT json_extract(a.metadata,'$.messageId') FROM artifacts a WHERE a.owner_id=@owner AND a.conversation_id=@conversation AND a.pinned=1 AND a.archived=0 AND json_extract(a.metadata,'$.messageId') IS NOT NULL`,
      )
      .all({ owner, conversation }) as { message_id: string }[]
  ).map((row) => row.message_id);
  return {
    position_message_id: readingPosition(owner, conversation),
    saved,
  };
}

function conversationMessage(
  owner: string,
  conversation: string,
  message: string,
) {
  return db
    .prepare(
      "SELECT id,created_at FROM messages WHERE id=? AND owner_id=? AND conversation_id=?",
    )
    .get(message, owner, conversation) as
    { id: string; created_at: number } | undefined;
}

export function savePosition(
  owner: string,
  conversation: string,
  body: unknown,
) {
  const { positionMessageId } = PositionInput.parse(body ?? {});
  return db
    .transaction(() => {
      const c = ownedConversation(conversation, owner);
      if (positionMessageId) {
        const valid = conversationMessage(owner, c.id, positionMessageId);
        if (!valid)
          throw new Problem(404, "Message not found in this conversation");
      }
      db.prepare(
        `INSERT INTO conversation_positions(owner_id,conversation_id,position_message_id,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(owner_id,conversation_id) DO UPDATE SET position_message_id=excluded.position_message_id,updated_at=excluded.updated_at`,
      ).run(owner, c.id, positionMessageId, now());
      return { position_message_id: positionMessageId };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// 2. Inbox
export { FEED_FILTERS } from "../shared/workspace-api.js";
import { FEED_FILTERS } from "../shared/workspace-api.js";
// One Feed card's state, read from the columns migration 078 keeps current on
// each conversation, plus what the card shows, fetched for the page only.
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
function feedSql(teams: boolean, folders: boolean, agent = false, results = false) {
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
  return `WITH RECURSIVE ${FOLDER_PROJECT},
${results ? `completed_results AS (
  SELECT r.conversation_id,r.id run_id,NULL message_id,r.updated_at done_at,'run:'||r.id card_key,
    json_extract(r.payload,'$.folderId') folder_id,json_type(r.payload,'$.folderId') IS NOT NULL has_folder
  FROM runs r WHERE r.owner_id=@owner AND r.state='completed'
    AND EXISTS(SELECT 1 FROM messages m INDEXED BY messages_feed_answers WHERE m.owner_id=r.owner_id AND m.conversation_id=r.conversation_id
      AND m.run_id=r.id AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 AND ${nonemptyAnswer("m.content")})
  UNION ALL
  SELECT conversation_id,NULL,id,created_at,'message:'||id,NULL,0
  FROM messages INDEXED BY messages_feed_answers WHERE owner_id=@owner AND run_id IS NULL AND role='assistant'
    AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND ${nonemptyAnswer("content")}
),` : ""}
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
  FROM conversations c
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
    ${doneOnly ? "NULL" : `COALESCE(
      (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=ap.run_id AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
      (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=ap.run_id AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at,m.rowid LIMIT 1)
    )`} approval_message_id
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
  shadow = false,
) {
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
  const sql = feedSql(!!teams, !!folders, !!options.agent);
  const where = {
    all: "NOT snoozed",
    // Completed results remain until individually dismissed, including when
    // newer work finishes or the conversation is snoozed. Threads without a
    // result keep their existing idle/snoozed behavior.
    done: `${results
      ? "(done_run_id IS NOT NULL OR done_message_id IS NOT NULL OR (NOT (COALESCE(is_needs,0) OR COALESCE(is_working,0) OR has_queued) AND NOT snoozed))"
      : "(done_run_id IS NOT NULL OR NOT (COALESCE(is_needs,0) OR COALESCE(is_working,0) OR has_queued)) AND NOT snoozed"}
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
  const projected = shadow ? projectionPage(db, params, filter, results) : null;
  const rows = projected ? projected.map(item => item.row) : db
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
  const summary = shadow ? projectionSummary(db, params) : db
    .prepare(
      `${sql} SELECT COALESCE(sum(is_needs),0) needs,COALESCE(sum(is_working),0) working,
      COALESCE(sum(has_queued),0) queued FROM flagged`,
    )
    .get(params) as Record<string, number>;
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
    items: projected ? projected.slice(0,40).map(item => item.display) : rows.map((row) => feedItem(owner, row, mode)),
    next:
      more && last
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
      later_due: laterDue.n,
      social_unread: unreadCount(owner),
      scheduled_failed: scheduled.failed,
      scheduled_pending: scheduled.pending,
    },
  };
}

/** The public endpoint keeps the legacy query throughout the shadow stage. */
export function feed(owner: string, options: Parameters<typeof readFeed>[1]) {
  return readFeed(owner, options);
}
export function shadowFeed(owner: string, options: Parameters<typeof readFeed>[1]) {
  return db.transaction(() => { assertFeedApplied(db); return readFeed(owner, options, true); })();
}
export function shadowDoneCardRows(owner: string, options: Parameters<typeof doneCardRows>[1]) {
  if (options.ids && !options.ids.length) return [];
  return db.transaction(() => {
    assertFeedApplied(db);
    return projectionDoneRows(db, { owner, now: options.atTime ?? now(),
      teams: options.teamIds.length ? JSON.stringify(options.teamIds) : null,
      folders: options.folders ? JSON.stringify(options.folders) : null, agent: options.agent ?? null,
      ids: options.ids ? JSON.stringify(options.ids) : null, at: options.before?.[0] ?? null,
      key: options.before?.[1] ?? null, limit: options.limit, detail: !!options.detail });
  })();
}

/** Shared Done projection: keeps the legacy feed's exact membership and identity. */
export function doneCardRows(owner: string, options: {
  folders: (string | null)[] | null; teamIds: string[]; agent?: string;
  before?: [number, string] | null; ids?: string[]; limit: number; detail?: boolean; atTime?: number;
}) {
  if (options.ids && !options.ids.length) return [];
  const identity = "'d:'||COALESCE(done_card_key,'idle:'||conversation_id)";
  const order = "conversation_id||char(31)||COALESCE(done_card_key,'')";
  const rows = db.prepare(`${feedSql(!!options.teamIds.length, !!options.folders, !!options.agent, true)},
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
    ),${cardSql(true)}`)
    .all({owner, now: options.atTime ?? now(), mode: "done", teams: options.teamIds.length ? JSON.stringify(options.teamIds) : null,
      folders: options.folders ? JSON.stringify(options.folders) : null, agent: options.agent ?? null,
      ids: options.ids ? JSON.stringify(options.ids) : null, at: options.before?.[0] ?? null,
      key: options.before?.[1] ?? null, limit: options.limit}) as FeedRow[];
  return rows.map(row => {
    const display = feedItem(owner, row, "done");
    if (display.last_message) display.last_message.content = row.message_content!;
    return { row, display };
  });
}

export function setDoneCardHidden(
  owner: string,
  conversation: string,
  body: unknown,
) {
  const { hidden, cardKey } = FeedUpdateInput.parse(body);
  return db
    .transaction(() => {
      ownedConversation(conversation, owner);
      const isRun = cardKey.startsWith("run:");
      const target = cardKey.slice(cardKey.indexOf(":") + 1);
      const record = db
        .prepare(
          isRun
            ? "SELECT 1 FROM runs WHERE id=? AND owner_id=? AND conversation_id=? AND state IN ('completed','cancelled','failed','interrupted')"
            : "SELECT 1 FROM messages WHERE id=? AND owner_id=? AND conversation_id=?",
        )
        .get(target, owner, conversation);
      if (!record) throw new Problem(404, "Done card not found");
      if (hidden) {
        db.prepare(
          "INSERT OR IGNORE INTO done_card_dismissals(owner_id,conversation_id,card_key,created_at) VALUES(?,?,?,?)",
        ).run(owner, conversation, cardKey, now());
      } else {
        db.prepare(
          "DELETE FROM done_card_dismissals WHERE owner_id=? AND conversation_id=? AND card_key=?",
        ).run(owner, conversation, cardKey);
      }
      return { ok: true };
    })
    .immediate();
}

function projectFor(owner: string, folder: string | null | undefined) {
  return (
    (db
      .prepare(
        `WITH RECURSIVE ${FOLDER_PROJECT} SELECT p.id,p.name FROM folder_project fp JOIN folders p ON p.id=fp.project_id AND p.owner_id=@owner WHERE fp.id IS @folder`,
      )
      .get({ owner, folder: folder ?? null }) as { id: string; name: string } | undefined) ||
    null
  );
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
          // Sent by Loop for you (a watched pull request or a teammate
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
          // What Loop observed in the agent's worktree. Absent for API agents
          // and for runs that have not started, so those cards are unchanged.
          ...(() => {
            const checkout = checkoutSummary(owner, run.id);
            const verification = verificationSummary(owner, run.id);
            return { ...(checkout ? { checkout } : {}), ...(verification ? { verification } : {}) };
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

type AwayItem = {
  conversation_id: string;
  title: string;
  agent_name: string | null;
  run_id: string;
  state: string;
  updated_at: number;
};
export function awaySummary(owner: string, since: number) {
  const summary = (condition: string, params: unknown[] = []) =>
    db
      .prepare(
        `SELECT r.conversation_id,c.title,a.name agent_name,r.id run_id,${publicState("r")} state,r.updated_at
        FROM runs r JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
        LEFT JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id
        WHERE r.owner_id=? AND (${condition})
        ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 20`,
      )
      .all(owner, ...params) as AwayItem[];
  return {
    completed: summary("r.state='completed' AND r.updated_at>?", [since]),
    needs: summary(
      `r.attention_dismissed_at IS NULL AND (r.state IN ('awaiting_approval','paused')
      OR EXISTS(SELECT 1 FROM approvals ap WHERE ap.run_id=r.id AND ap.owner_id=r.owner_id AND ap.state='pending' AND ap.expires_at>?)
      OR (r.state IN ('failed','interrupted') AND NOT EXISTS(SELECT 1 FROM runs newer WHERE newer.owner_id=r.owner_id AND newer.conversation_id=r.conversation_id AND (newer.created_at>r.created_at OR (newer.created_at=r.created_at AND newer.rowid>r.rowid)))))`,
      [now()],
    ),
    failed: summary("r.state IN ('failed','interrupted') AND r.updated_at>?", [
      since,
    ]),
  };
}

// ---------------------------------------------------------------------------
// 3. Saved
// One list for everything you keep: results and messages alike. A reply that
// has a result card is saved by pinning that result, so saving either one
// saves both and the list shows it once.
function resultFor(owner: string, messageId: string) {
  return db
    .prepare(
      "SELECT a.id,a.pinned FROM artifacts a JOIN messages m ON m.id=? AND m.owner_id=a.owner_id AND m.conversation_id=a.conversation_id WHERE a.owner_id=? AND a.archived=0 AND json_extract(a.metadata,'$.messageId')=m.id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1",
    )
    .get(messageId, owner) as { id: string; pinned: number } | undefined;
}

export function setSaved(owner: string, messageId: string, on: boolean) {
  return db
    .transaction(() => {
      const message = ownedMessage(messageId, owner);
      if (message.metadata.progress)
        throw new Problem(400, "Only saved messages can be kept");
      const result = resultFor(owner, messageId),
        savedAt = now();
      if (result && result.pinned !== Number(on)) {
        db.prepare(
          "UPDATE artifacts SET pinned=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND pinned<>?",
        ).run(Number(on), savedAt, result.id, owner, Number(on));
      }
        on && !result
          ? db
              .prepare(
                "INSERT OR IGNORE INTO message_bookmarks(owner_id,message_id,created_at) VALUES(?,?,?)",
              )
              .run(owner, messageId, savedAt).changes
          : db
              .prepare(
                "DELETE FROM message_bookmarks WHERE owner_id=? AND message_id=?",
              )
              .run(owner, messageId).changes;
      return { ok: true as const, saved: on };
    })
    .immediate();
}

const savedCursor = z.object({ at: z.number(), key: z.string() });
// A LIKE pattern that matches the text literally.
const contains = (text: string) =>
  "%" + text.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
export function listSaved(
  owner: string,
  options: {
    before?: string;
    folder?: string;
    teams?: string[];
    /** Text in a saved item, its thread title or its label. */
    q?: string;
  } = {},
) {
  const cursor = options.before
    ? decode(options.before, savedCursor, "saved")
    : null;
  if (options.folder) ownedFolder(options.folder, owner);
  const page = 30;
  // The same project and team scope as the results feed.
  const params = {
    owner,
    at: cursor?.at ?? null,
    key: cursor?.key ?? null,
    limit: page + 1,
    folders: options.folder
      ? JSON.stringify(projectFolders(owner, options.folder))
      : null,
    teams: options.teams?.length ? JSON.stringify(options.teams) : null,
    q: options.q?.trim() ? contains(options.q.trim()) : null,
  };
  const after = (at: string, key: string) =>
    `(@at IS NULL OR ${at}<@at OR (${at}=@at AND ${key}<@key))`;
  const messages = db
    .prepare(
      `WITH RECURSIVE ${FOLDER_PROJECT}
      SELECT 'm:'||b.message_id key,b.created_at saved_at,b.message_id,m.conversation_id,
        c.title conversation_title,m.role,substr(m.content,1,4000) content,m.created_at,
        a.id agent_id,a.name agent_name,a.provider,project.name project_name,l.label
      FROM message_bookmarks b
      LEFT JOIN saved_labels l ON l.owner_id=b.owner_id AND l.item_key='m:'||b.message_id
      JOIN messages m ON m.id=b.message_id AND m.owner_id=b.owner_id
      JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=b.owner_id
      LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=b.owner_id
      LEFT JOIN agents a ON a.id=COALESCE(r.agent_id,c.agent_id) AND a.owner_id=b.owner_id
      LEFT JOIN folder_project fp ON fp.id IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)
      LEFT JOIN folders project ON project.id=fp.project_id AND project.owner_id=b.owner_id
      WHERE b.owner_id=@owner AND ${after("b.created_at", "'m:'||b.message_id")}
        AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)))
        AND (@teams IS NULL OR c.team_id IN (SELECT value FROM json_each(@teams)))
        AND (@q IS NULL OR m.content LIKE @q ESCAPE '\\' OR c.title LIKE @q ESCAPE '\\' OR l.label LIKE @q ESCAPE '\\')
      ORDER BY b.created_at DESC,key DESC LIMIT @limit`,
    )
    .all(params) as (Record<string, unknown> & {
    key: string;
    saved_at: number;
    content: string;
  })[];
  // The same columns as a saved card in the results feed.
  const results = db
    .prepare(
      `SELECT 'a:'||a.id key,COALESCE(p.saved_at,a.updated_at) saved_at,a.*,r.state run_state,r.error run_error,
        json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,g.name,g.provider,
        (SELECT team_id FROM conversations WHERE id=a.conversation_id) team_id,l.label saved_label
      FROM artifacts a JOIN artifact_bookmarks p ON p.artifact_id=a.id
      LEFT JOIN saved_labels l ON l.owner_id=a.owner_id AND l.item_key='a:'||a.id
      LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
      LEFT JOIN agents g ON g.id=a.agent_id
      WHERE a.owner_id=@owner AND a.archived=0 AND a.pinned=1 AND ${fileArtifactSql}
        AND json_extract(a.metadata,'$.snippet') IS NULL
        AND ${after("COALESCE(p.saved_at,a.updated_at)", "'a:'||a.id")}
        AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS a.folder_id))
        AND (@teams IS NULL OR a.conversation_id IN (SELECT id FROM conversations WHERE owner_id=@owner AND team_id IN (SELECT value FROM json_each(@teams))))
        AND (@q IS NULL OR a.title LIKE @q ESCAPE '\\' OR a.content LIKE @q ESCAPE '\\' OR l.label LIKE @q ESCAPE '\\')
      ORDER BY COALESCE(p.saved_at,a.updated_at) DESC,key DESC LIMIT @limit`,
    )
    .all(params) as (Record<string, unknown> & {
    key: string;
    saved_at: number;
  })[];
  const merged = [
    ...messages.map(({ key, saved_at, content, label, ...row }) => ({
      kind: "message" as const,
      key,
      saved_at,
      label: (label as string | null) ?? null,
      message: {
        ...row,
        preview: collapse(content, 280),
        // Markdown for full-size cards; the client clips it visually.
        content,
      },
    })),
    ...results.map(({ key, saved_at, saved_label, ...row }) => ({
      kind: "result" as const,
      key,
      saved_at,
      label: (saved_label as string | null) ?? null,
      result: row,
    })),
  ].sort((a, b) => b.saved_at - a.saved_at || (a.key < b.key ? 1 : -1));
  const more = merged.length > page;
  const items = merged.slice(0, page);
  const last = items.at(-1);
  return {
    items,
    next: more && last ? encode({ at: last.saved_at, key: last.key }) : null,
  };
}

/**
 * Set or clear the short label of a saved item ("Chosen approach"). Only an
 * item the owner currently has saved can be labelled.
 */
export function setSavedLabel(owner: string, body: unknown) {
  const d = SavedLabelInput.parse(body);
  return db
    .transaction(() => {
      const target = d.key.slice(2);
      const saved = d.key.startsWith("m:")
        ? db
            .prepare(
              "SELECT 1 FROM message_bookmarks WHERE owner_id=? AND message_id=?",
            )
            .get(owner, target)
        : db
            .prepare(
              "SELECT 1 FROM artifacts a JOIN artifact_bookmarks p ON p.artifact_id=a.id WHERE a.id=? AND a.owner_id=? AND a.pinned=1 AND a.archived=0",
            )
            .get(target, owner);
      if (!saved) throw new Problem(404, "Saved item not found");
      if (d.label)
        db.prepare(
          `INSERT INTO saved_labels(owner_id,item_key,label,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(owner_id,item_key) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at`,
        ).run(owner, d.key, d.label, now());
      else
        db.prepare(
          "DELETE FROM saved_labels WHERE owner_id=? AND item_key=?",
        ).run(owner, d.key);
      return { key: d.key, label: d.label || null };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// 4. Outline
type OutlineItem = {
  message_id: string;
  kind: "prompt" | "result" | "approval" | "failure" | "saved";
  preview: string;
  created_at: number;
  run_id: string | null;
};
export function conversationOutline(
  owner: string,
  conversation: string,
  q?: string,
) {
  ownedConversation(conversation, owner);
  if (q?.trim())
    return { items: [], matches: threadMatches(owner, conversation, q.trim()) };
  const messages = db
    .prepare(
      "SELECT id,run_id,role,substr(content,1,1000) content,created_at,rowid seq FROM messages WHERE owner_id=? AND conversation_id=? AND json_extract(metadata,'$.progress') IS NOT 1 ORDER BY created_at,rowid",
    )
    .all(owner, conversation) as {
    id: string;
    run_id: string | null;
    role: string;
    content: string;
    created_at: number;
    seq: number;
  }[];
  const runs = db
    .prepare(
      "SELECT r.id,r.state,r.error,(SELECT count(*) FROM approvals a WHERE a.run_id=r.id AND a.owner_id=r.owner_id) approvals FROM runs r WHERE r.owner_id=? AND r.conversation_id=?",
    )
    .all(owner, conversation) as {
    id: string;
    state: string;
    error: string | null;
    approvals: number;
  }[];
  const saved = new Set(conversationReturnState(owner, conversation).saved);
  const order = new Map(messages.map((m) => [m.id, m.seq]));
  const items: OutlineItem[] = [];
  const add = (
    m: (typeof messages)[number],
    kind: OutlineItem["kind"],
    preview = collapse(m.content, 200),
  ) =>
    items.push({
      message_id: m.id,
      kind,
      preview,
      created_at: m.created_at,
      run_id: m.run_id,
    });
  for (const m of messages) if (m.role === "user") add(m, "prompt");
  for (const run of runs) {
    const own = messages.filter((m) => m.run_id === run.id);
    const last = own.at(-1);
    if (!last) continue;
    const answer = own.filter((m) => m.role !== "user").at(-1);
    if (run.state === "completed" && answer) add(answer, "result");
    if (["failed", "interrupted"].includes(run.state))
      add(
        last,
        "failure",
        collapse(run.error, 200) ||
          (run.state === "failed" ? "Run failed" : "Run interrupted"),
      );
    // Never expose tool arguments here; the approval card holds them.
    if (run.approvals > 0)
      add(
        last,
        "approval",
        run.approvals > 1
          ? `${run.approvals} approvals requested`
          : "Approval requested",
      );
  }
  for (const m of messages) if (saved.has(m.id)) add(m, "saved");
  const rank = { prompt: 0, approval: 1, failure: 2, result: 3, saved: 4 };
  items.sort(
    (a, b) =>
      a.created_at - b.created_at ||
      order.get(a.message_id)! - order.get(b.message_id)! ||
      rank[a.kind] - rank[b.kind],
  );
  return { items };
}

/**
 * Text search inside one thread, across every kind of message: your prompts,
 * the agent's answers and progress updates, results, failures and saved
 * messages. Each match says what it is, so no filter has to be guessed first.
 * Approval requests are not searched: their arguments stay on the card.
 */
type ThreadMatch = {
  message_id: string;
  kind: "prompt" | "response" | "update" | "result" | "failure";
  saved: boolean;
  preview: string;
  created_at: number;
};
function threadMatches(owner: string, conversation: string, q: string) {
  const pattern = contains(q);
  const rows = db
    .prepare(
      `SELECT m.id,m.role,m.run_id,m.content,m.created_at,
        COALESCE(json_extract(m.metadata,'$.progress'),0) progress,r.state run_state,r.error run_error,
        m.id=(SELECT f.id FROM messages f WHERE f.owner_id=m.owner_id AND f.conversation_id=m.conversation_id AND f.run_id=m.run_id
          AND f.role='assistant' AND COALESCE(json_extract(f.metadata,'$.progress'),0)=0 AND length(trim(f.content))>0
          ORDER BY f.created_at DESC,f.rowid DESC LIMIT 1) final,
        m.id=(SELECT l.id FROM messages l WHERE l.owner_id=m.owner_id AND l.conversation_id=m.conversation_id AND l.run_id=m.run_id
          ORDER BY l.created_at DESC,l.rowid DESC LIMIT 1) last
      FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
      WHERE m.owner_id=@owner AND m.conversation_id=@conversation
        AND NOT (json_extract(m.metadata,'$.progress') IS 1 AND json_extract(m.metadata,'$.final') IS 1)
        AND (m.content LIKE @q ESCAPE '\\' OR (r.state IN ('failed','interrupted') AND r.error LIKE @q ESCAPE '\\'))
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 100`,
    )
    .all({ owner, conversation, q: pattern }) as {
    id: string;
    role: string;
    run_id: string | null;
    content: string;
    created_at: number;
    progress: number;
    run_state: string | null;
    run_error: string | null;
    final: number;
    last: number;
  }[];
  const saved = new Set(conversationReturnState(owner, conversation).saved);
  const needle = q.toLowerCase();
  const matches: ThreadMatch[] = [];
  for (const row of rows) {
    const failed =
      ["failed", "interrupted"].includes(row.run_state || "") && row.last;
    const inError =
      failed && (row.run_error || "").toLowerCase().includes(needle);
    const inText = row.content.toLowerCase().includes(needle);
    if (inText)
      matches.push({
        message_id: row.id,
        kind:
          row.role === "user"
            ? "prompt"
            : row.progress
              ? "update"
              : row.final && row.run_state === "completed"
                ? "result"
                : "response",
        saved: saved.has(row.id),
        preview: excerpt(row.content, needle),
        created_at: row.created_at,
      });
    if (inError)
      matches.push({
        message_id: row.id,
        kind: "failure",
        saved: saved.has(row.id),
        preview: excerpt(row.run_error!, needle),
        created_at: row.created_at,
      });
  }
  return matches;
}
/** About 160 characters around the first match, on one line. */
function excerpt(text: string, needle: string) {
  const flat = collapse(text, 30000);
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, 160);
  const start = Math.max(0, at - 60);
  return (
    (start ? "…" : "") +
    flat.slice(start, start + 160) +
    (start + 160 < flat.length ? "…" : "")
  );
}

// ---------------------------------------------------------------------------
// 5. Later
type LaterItem = {
  id: string;
  owner_id: string;
  kind: "conversation" | "artifact" | "message" | "story";
  target_id: string;
  condition: "time" | "run_finished" | "project_open";
  due_at: number | null;
  project_id: string | null;
  created_at: number;
  surfaced_at: number | null;
  done_at: number | null;
  snoozes: number;
};
const YEAR = 366 * 24 * 60 * 60 * 1000;

function laterTarget(owner: string, kind: LaterItem["kind"], target: string) {
  if (kind === "story") {
    const story = savedStory(owner, target);
    if (!story) return null;
    return {
      title: story.title,
      preview: story.summary || story.url,
      content: story.summary || "",
      conversation_id: null,
      message_id: null,
      agent_name: null,
      provider: null,
      folder_id: null,
      url: story.url,
    };
  }
  if (kind === "conversation") {
    const c = db
      .prepare(
        `SELECT c.id,c.title,${conversationFolder("c")} folder_id,a.name agent_name,a.provider FROM conversations c LEFT JOIN agents a ON a.id=c.agent_id AND a.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=?`,
      )
      .get(target, owner) as { id: string; title: string; folder_id: string | null; agent_name: string | null; provider: string | null } | undefined;
    if (!c) return null;
    const last = db
      .prepare(
        "SELECT substr(content,1,4000) content FROM messages WHERE owner_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(owner, c.id) as { content: string } | undefined;
    return {
      title: c.title as string,
      preview: collapse(last?.content, 200),
      content: last?.content ?? "",
      conversation_id: c.id as string,
      message_id: null,
      agent_name: c.agent_name as string | null,
      provider: c.provider as string | null,
      folder_id: c.folder_id as string | null,
      url: "/?conversation=" + encodeURIComponent(c.id),
    };
  }
  if (kind === "message") {
    const m = db
      .prepare(
        `SELECT m.id,substr(m.content,1,4000) content,m.conversation_id,c.title,a.name agent_name,a.provider,
        COALESCE((SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.id=m.run_id AND r.owner_id=m.owner_id),c.project_id) folder_id
        FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
        LEFT JOIN agents a ON a.id=c.agent_id AND a.owner_id=c.owner_id WHERE m.id=? AND m.owner_id=?`,
      )
      .get(target, owner) as ({ id: string; title: string; folder_id: string | null; agent_name: string | null; provider: string | null } & { content: string; conversation_id: string }) | undefined;
    if (!m) return null;
    return {
      title: m.title as string,
      preview: collapse(m.content, 200),
      content: m.content as string,
      conversation_id: m.conversation_id as string,
      message_id: m.id as string,
      agent_name: m.agent_name as string | null,
      provider: m.provider as string | null,
      folder_id: m.folder_id as string | null,
      url:
        "/?conversation=" +
        encodeURIComponent(m.conversation_id) +
        "&message=" +
        encodeURIComponent(m.id),
    };
  }
  const a = db
    .prepare(
      "SELECT a.id,a.title,substr(a.content,1,4000) content,a.conversation_id,json_extract(a.metadata,'$.messageId') message_id,a.folder_id,g.name agent_name,g.provider FROM artifacts a LEFT JOIN agents g ON g.id=a.agent_id AND g.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=?",
    )
    .get(target, owner) as ({ id: string; title: string; folder_id: string | null; agent_name: string | null; provider: string | null } & { content: string; conversation_id: string | null; message_id: string | null }) | undefined;
  if (!a) return null;
  return {
    title: a.title as string,
    preview: collapse(a.content, 200),
    content: a.content as string,
    conversation_id: a.conversation_id as string | null,
    message_id: (a.message_id as string | null) ?? null,
    agent_name: a.agent_name as string | null,
    provider: a.provider as string | null,
    folder_id: a.folder_id as string | null,
    url: resultUrl(a),
  };
}

function validTrigger(
  d: {
    kind?: LaterItem["kind"];
    condition: LaterItem["condition"];
    dueAt?: number;
    projectId?: string;
  },
  time: number,
) {
  // A story has no run and belongs to no project: it comes back at a time.
  if (d.kind === "story" && d.condition !== "time")
    throw new Problem(400, "Choose when to bring this story back");
  if (d.condition === "time") {
    if (d.dueAt === undefined)
      throw new Problem(400, "Choose when to bring this back");
    if (d.dueAt <= time || d.dueAt > time + YEAR)
      throw new Problem(400, "Choose a time within the next year");
  }
  if (d.condition === "project_open" && !d.projectId)
    throw new Problem(400, "Choose a project");
}

/**
 * Remind me about a thread, result or message. An open reminder for the same
 * item is replaced; its id is returned as `replaced` so Undo can reopen it.
 */
export function createLater(owner: string, body: unknown) {
  const d = laterInput.parse(body);
  const time = now();
  validTrigger(d, time);
  return db
    .transaction(() => {
      if (d.kind === "story") {
        // A story is not an owned row: it is public feed content, saved only
        // if this owner follows the feed it came from.
        if (!savedStory(owner, d.targetId))
          throw new Problem(404, "Item not found");
      } else
        owned(
          {
            conversation: "conversations",
            artifact: "artifacts",
            message: "messages",
          }[d.kind],
          d.targetId,
          owner,
        );
      if (d.projectId) ownedFolder(d.projectId, owner);
      const replaced = db
        .prepare(
          "SELECT id FROM later_items WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
        )
        .get(owner, d.kind, d.targetId) as { id: string } | undefined;
      db.prepare(
        "UPDATE later_items SET done_at=? WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
      ).run(time, owner, d.kind, d.targetId);
      const itemId = id();
      db.prepare(
        "INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,project_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        itemId,
        owner,
        d.kind,
        d.targetId,
        d.condition,
        d.condition === "time" ? d.dueAt : null,
        d.condition === "project_open" ? d.projectId : null,
        time,
      );
      return { ...laterRow(owner, itemId)!, replaced: replaced?.id ?? null };
    })
    .immediate();
}

/**
 * Snooze a reminder again: the same item gets a new trigger in place, so its
 * target and history stay, and it leaves "Back now" until the new trigger.
 */
export function snoozeLater(owner: string, itemId: string, body: unknown) {
  const d = laterInput
    .pick({ condition: true, dueAt: true, projectId: true })
    .parse(body);
  const time = now();
  validTrigger(d, time);
  return db
    .transaction(() => {
      const item = laterRow(owner, itemId);
      if (!item) throw new Problem(404, "Item not found");
      if (item.done_at !== null)
        throw new Problem(409, "This reminder is already done");
      if (d.projectId) ownedFolder(d.projectId, owner);
      db.prepare(
        "UPDATE later_items SET condition=?,due_at=?,project_id=?,surfaced_at=NULL,snoozes=snoozes+1 WHERE id=? AND owner_id=? AND done_at IS NULL",
      ).run(
        d.condition,
        d.condition === "time" ? d.dueAt : null,
        d.condition === "project_open" ? d.projectId : null,
        itemId,
        owner,
      );
      return laterRow(owner, itemId)!;
    })
    .immediate();
}

/**
 * Undo "Done" or a replacement: reopen a reminder, unless the item already
 * has another open reminder (that newer one wins).
 */
export function reopenLater(owner: string, itemId: string) {
  return db
    .transaction(() => {
      const item = laterRow(owner, itemId);
      if (!item) throw new Problem(404, "Item not found");
      if (item.done_at === null) return item;
      const open = db
        .prepare(
          "SELECT 1 FROM later_items WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
        )
        .get(owner, item.kind, item.target_id);
      if (open)
        throw new Problem(409, "This item already has another reminder");
      db.prepare(
        "UPDATE later_items SET done_at=NULL WHERE id=? AND owner_id=?",
      ).run(itemId, owner);
      return laterRow(owner, itemId)!;
    })
    .immediate();
}
const laterRow = (owner: string, itemId: string) =>
  db
    .prepare("SELECT * FROM later_items WHERE id=? AND owner_id=?")
    .get(itemId, owner) as LaterItem | undefined;

export function listLater(owner: string) {
  const rows = db
    .prepare(
      "SELECT * FROM later_items WHERE owner_id=? AND done_at IS NULL ORDER BY COALESCE(surfaced_at,due_at,created_at),created_at LIMIT 400",
    )
    .all(owner) as LaterItem[];
  const view = (item: LaterItem) => {
    const target = laterTarget(owner, item.kind, item.target_id);
    const project =
      projectFor(owner, item.project_id) ||
      projectFor(owner, target?.folder_id);
    return {
      ...item,
      title: target?.title ?? "Item unavailable",
      preview: target?.preview ?? "",
      content: target?.content ?? "",
      provider: target?.provider ?? null,
      conversation_id: target?.conversation_id ?? null,
      message_id: target?.message_id ?? null,
      agent_name: target?.agent_name ?? null,
      project_name: project?.name ?? null,
      // A saved story lives outside Loop, so Later needs its address to open
      // it; everything else is opened by its conversation or result.
      url: item.kind === "story" ? (target?.url ?? null) : null,
    };
  };
  return {
    due: rows
      .filter((row) => row.surfaced_at !== null)
      .sort((a, b) => b.surfaced_at! - a.surfaced_at!)
      .map(view),
    upcoming: rows.filter((row) => row.surfaced_at === null).map(view),
  };
}

export function finishLater(owner: string, itemId: string) {
  const changed = db
    .prepare(
      "UPDATE later_items SET done_at=? WHERE id=? AND owner_id=? AND done_at IS NULL",
    )
    .run(now(), itemId, owner).changes;
  if (!changed && !laterRow(owner, itemId))
    throw new Problem(404, "Item not found");
  return { ok: true };
}

export function projectOpened(owner: string, project: string) {
  ownedFolder(project, owner);
  return {
    surfaced: db
      .prepare(
        "UPDATE later_items SET surfaced_at=? WHERE owner_id=? AND condition='project_open' AND project_id=? AND surfaced_at IS NULL AND done_at IS NULL",
      )
      .run(now(), owner, project).changes,
  };
}

// Push to every device of the owner. The key doubles as the notification tag.
export function enqueuePush(
  owner: string,
  key: string,
  message: { title: string; body: string; url: string },
  category: "reminders" | "social" = "reminders",
) {
  db.prepare(
    "INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at,category) SELECT id,?,?,?,?,?,? FROM push_subscriptions WHERE owner_id=?",
  ).run(
    key,
    message.title.slice(0, 120),
    message.body.slice(0, 140),
    message.url,
    now(),
    category,
    owner,
  );
}

// Worker job. Surfacing and its push commit together, exactly once per item.
export function surfaceLater(time = now()) {
  return db
    .transaction(() => {
      const due = db
        .prepare(
          `SELECT l.* FROM later_items l WHERE l.done_at IS NULL AND l.surfaced_at IS NULL AND (
          (l.condition='time' AND l.due_at<=@now) OR
          (l.condition='run_finished' AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=l.owner_id AND r.state IN ${ACTIVE_STATES}
            AND r.conversation_id=(CASE l.kind
              WHEN 'conversation' THEN l.target_id
              WHEN 'message' THEN (SELECT m.conversation_id FROM messages m WHERE m.id=l.target_id AND m.owner_id=l.owner_id)
              ELSE (SELECT COALESCE(a.conversation_id,(SELECT ar.conversation_id FROM runs ar WHERE ar.id=a.run_id)) FROM artifacts a WHERE a.id=l.target_id AND a.owner_id=l.owner_id) END))))
          ORDER BY l.created_at LIMIT 100`,
        )
        .all({ now: time }) as LaterItem[];
      let surfaced = 0;
      for (const item of due) {
        const changed = db
          .prepare(
            "UPDATE later_items SET surfaced_at=? WHERE id=? AND surfaced_at IS NULL AND done_at IS NULL",
          )
          .run(time, item.id).changes;
        if (!changed) continue;
        surfaced++;
        const target = laterTarget(item.owner_id, item.kind, item.target_id);
        enqueuePush(item.owner_id, "later-" + item.id, {
          title: "Back from Later",
          body: target?.title || "An item you deferred is ready",
          url:
            item.kind === "story"
              ? "/?social=" + encodeURIComponent(item.target_id)
              : target?.url || "/?page=profile",
        });
      }
      return surfaced;
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// 6. Scheduled sends
const MONTH = 30 * 24 * 60 * 60 * 1000;
type ScheduledSend = {
  id: string;
  owner_id: string;
  agent_id: string;
  conversation_id: string | null;
  folder_id: string | null;
  /** 1 when a project (or explicitly none) was chosen; 0 uses the agent's. */
  folder_chosen: number;
  input: string;
  attachment_ids: string;
  reply_to_message_id: string | null;
  reply_excerpt: string | null;
  idempotency_key: string;
  send_at: number;
  state: string;
  run_id: string | null;
  error: string | null;
  created_at: number;
};

function validSendAt(sendAt: number, time = now()) {
  if (sendAt <= time || sendAt > time + MONTH)
    throw new Problem(400, "Choose a send time within the next 30 days");
}

export function createScheduledSend(owner: string, body: unknown) {
  const d = scheduleInput.parse(body);
  return db
    .transaction(() => {
      // A retry of accepted work returns its receipt first, before any check
      // that depends on when it is retried (the time may have passed).
      const prior = db
        .prepare(
          "SELECT * FROM scheduled_sends WHERE owner_id=? AND idempotency_key=?",
        )
        .get(owner, d.idempotencyKey) as ScheduledSend | undefined;
      if (prior) {
        const same =
          prior.agent_id === d.agentId &&
          prior.input === d.input &&
          prior.conversation_id === (d.conversationId ?? null) &&
          prior.folder_id === (d.folderId ?? null) &&
          prior.folder_chosen === Number(d.folderId !== undefined) &&
          prior.reply_to_message_id === (d.replyToMessageId ?? null) &&
          prior.reply_excerpt === (d.replyExcerpt ?? null) &&
          prior.attachment_ids === JSON.stringify(d.attachmentIds) &&
          prior.send_at === d.sendAt;
        if (!same)
          throw new Problem(409, "This request key belongs to different work");
        return { created: false, row: prior };
      }
      validSendAt(d.sendAt);
      if (
        db
          .prepare("SELECT 1 FROM runs WHERE owner_id=? AND idempotency_key=?")
          .get(owner, d.idempotencyKey)
      )
        throw new Problem(409, "This request key belongs to different work");
      const agent = ownedAgent(d.agentId, owner);
      if (agent.retired_at)
        throw new Problem(
          409,
          "This agent is retired. Restore it from its profile before sending new work.",
        );
      if (!agent.connection_id)
        throw new Problem(409, "Connect a provider to this agent first");
      if (d.conversationId) {
        const c = ownedConversation(d.conversationId, owner);
        if (c.agent_id !== agent.id)
          throw new Problem(400, "This conversation belongs to another agent");
      }
      if (d.folderId) ownedFolder(d.folderId, owner);
      const files = attachedFiles(owner, d.attachmentIds);
      if (d.replyToMessageId)
        messageReplyContext(
          owner,
          agent.id,
          d.conversationId,
          d.replyToMessageId,
          d.replyExcerpt,
        );
      const pending = db
        .prepare(
          "SELECT count(*) n FROM scheduled_sends WHERE owner_id=? AND state='scheduled'",
        )
        .get(owner) as { n: number };
      if (pending.n >= 100)
        throw new Problem(
          429,
          "You have 100 scheduled messages. Cancel some first.",
        );
      const sendId = id();
      db.prepare(
        `INSERT INTO scheduled_sends(id,owner_id,agent_id,conversation_id,folder_id,folder_chosen,input,attachment_ids,reply_to_message_id,reply_excerpt,idempotency_key,send_at,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',?)`,
      ).run(
        sendId,
        owner,
        agent.id,
        d.conversationId ?? null,
        d.folderId ?? null,
        Number(d.folderId !== undefined),
        d.input,
        JSON.stringify(files.map((file) => file.id)),
        d.replyToMessageId ?? null,
        d.replyToMessageId ? (d.replyExcerpt ?? null) : null,
        d.idempotencyKey,
        d.sendAt,
        now(),
      );
      return { created: true, row: scheduledSend(owner, sendId)! };
    })
    .immediate();
}

function scheduledSend(owner: string, sendId: string) {
  return db
    .prepare("SELECT * FROM scheduled_sends WHERE id=? AND owner_id=?")
    .get(sendId, owner) as ScheduledSend | undefined;
}

/**
 * Scheduled messages that still need you: waiting to send, or not sent
 * because Loop refused them when they were due. Owner-wide, or one thread's.
 */
const failedCursor = z.object({
  at: z.number(),
  created: z.number(),
  id: z.string(),
});
const FAILED_PAGE = 100;
export function listScheduledSends(
  owner: string,
  conversation?: string,
  failedBefore?: string,
) {
  if (conversation) ownedConversation(conversation, owner);
  const cursor = failedBefore
    ? decode(failedBefore, failedCursor, "scheduled")
    : null;
  // Waiting and not-sent messages are read separately, so a long history of
  // failures can never hide work that is still going to be sent. Failures
  // page newest first, so every one stays reachable to retry or dismiss.
  const select = `SELECT s.*,a.name agent_name,a.provider,c.title conversation_title,f.name folder_name
        FROM scheduled_sends s
        LEFT JOIN agents a ON a.id=s.agent_id AND a.owner_id=s.owner_id
        LEFT JOIN conversations c ON c.id=s.conversation_id AND c.owner_id=s.owner_id
        LEFT JOIN folders f ON f.id=COALESCE(s.folder_id,c.project_id) AND f.owner_id=s.owner_id
        WHERE s.owner_id=@owner AND (@conversation IS NULL OR s.conversation_id=@conversation)`;
  const failed = db
    .prepare(
      `${select} AND s.state='failed'
        AND (@at IS NULL OR s.send_at<@at OR (s.send_at=@at AND (s.created_at<@created OR (s.created_at=@created AND s.id<@id))))
        ORDER BY s.send_at DESC,s.created_at DESC,s.id DESC LIMIT @limit`,
    )
    .all({
      owner,
      conversation: conversation ?? null,
      at: cursor?.at ?? null,
      created: cursor?.created ?? null,
      id: cursor?.id ?? null,
      limit: FAILED_PAGE + 1,
    }) as ScheduledSend[];
  const more = failed.length > FAILED_PAGE;
  if (more) failed.pop();
  const last = failed.at(-1);
  // Pending messages are capped at 100 per owner, so one read holds them all.
  const pending = cursor
    ? []
    : db
        .prepare(
          `${select} AND s.state='scheduled' ORDER BY s.send_at,s.created_at`,
        )
        .all({ owner, conversation: conversation ?? null });
  // Descriptors let "Copy to a draft" bring the files back with the text.
  const withFiles = (row: ScheduledSend) => ({
    ...row,
    attachments: attachmentDescriptors(owner, JSON.parse(row.attachment_ids)),
  });
  return {
    items: [...failed, ...(pending as ScheduledSend[])].map(withFiles),
    failed_next:
      more && last
        ? encode({ at: last.send_at, created: last.created_at, id: last.id })
        : null,
  };
}

/** Cancel a waiting message, or dismiss one that could not be sent. */
export function cancelScheduledSend(owner: string, sendId: string) {
  return db
    .transaction(() => {
      const row = scheduledSend(owner, sendId);
      if (!row) throw new Problem(404, "Item not found");
      if (!["scheduled", "failed"].includes(row.state))
        throw new Problem(409, "This message was already sent or cancelled");
      db.prepare(
        "UPDATE scheduled_sends SET state='cancelled' WHERE id=? AND owner_id=? AND state IN ('scheduled','failed')",
      ).run(sendId, owner);
      return { ok: true };
    })
    .immediate();
}

/**
 * Change the text or time of a message that is still waiting to send. A
 * message that could not be sent can also be edited; that schedules it again
 * at the chosen time. It was refused, never accepted, so its stored key has
 * no run and cannot duplicate work.
 */
export function editScheduledSend(
  owner: string,
  sendId: string,
  body: unknown,
) {
  const d = ScheduleUpdateInput.parse(body ?? {});
  return db
    .transaction(() => {
      const row = scheduledSend(owner, sendId);
      if (!row) throw new Problem(404, "Item not found");
      if (!["scheduled", "failed"].includes(row.state))
        throw new Problem(409, "This message was already sent or cancelled");
      if (row.state === "failed") {
        if (d.sendAt === undefined)
          throw new Problem(400, "Choose a new time to send it");
        if (row.run_id) throw new Problem(409, "This message was already sent");
        const pending = db
          .prepare(
            "SELECT count(*) n FROM scheduled_sends WHERE owner_id=? AND state='scheduled'",
          )
          .get(owner) as { n: number };
        if (pending.n >= 100)
          throw new Problem(
            429,
            "You have 100 scheduled messages. Cancel some first.",
          );
      }
      if (d.sendAt !== undefined) validSendAt(d.sendAt);
      db.prepare(
        "UPDATE scheduled_sends SET input=?,send_at=?,state='scheduled',error=NULL WHERE id=? AND owner_id=? AND state IN ('scheduled','failed')",
      ).run(d.input ?? row.input, d.sendAt ?? row.send_at, sendId, owner);
      return scheduledSend(owner, sendId)!;
    })
    .immediate();
}

// Submits a scheduled message with its stored idempotency key, inside the
// caller's transaction: if it was already accepted, submit() returns that run.
function submitScheduled(row: ScheduledSend) {
  const run = submit(row.owner_id, {
    agentId: row.agent_id,
    conversationId: row.conversation_id ?? undefined,
    // "No project" stays null; only an unchosen project uses the agent's.
    folderId: row.folder_chosen ? row.folder_id : undefined,
    input: row.input,
    attachmentIds: JSON.parse(row.attachment_ids),
    replyToMessageId: row.reply_to_message_id ?? undefined,
    replyExcerpt: row.reply_excerpt ?? undefined,
    idempotencyKey: row.idempotency_key,
    // A deferred message never steers work that started after it was
    // written; it queues behind the conversation's current run.
    steer: false,
    personal: true,
  });
  db.prepare(
    "UPDATE scheduled_sends SET state='submitted',run_id=?,error=NULL WHERE id=?",
  ).run(run.id, row.id);
  return run;
}
const refusal = (error: unknown) =>
  error instanceof Problem
    ? error.message
    : error instanceof ZodError
      ? "This scheduled message is no longer valid."
      : null;

/**
 * Send a message that could not be sent, now, after you ask to. It was
 * refused, never accepted, so its stored key cannot duplicate work; if it is
 * refused again the reason is kept and returned.
 */
export function retryScheduledSend(owner: string, sendId: string) {
  return db
    .transaction(() => {
      const row = scheduledSend(owner, sendId);
      if (!row) throw new Problem(404, "Item not found");
      if (row.state !== "failed")
        throw new Problem(
          409,
          "Only a message that could not be sent can be retried",
        );
      try {
        return {
          run: submitScheduled(row),
          row: scheduledSend(owner, sendId)!,
        };
      } catch (error) {
        const reason = refusal(error);
        if (reason === null) throw error;
        db.prepare("UPDATE scheduled_sends SET error=? WHERE id=?").run(
          reason,
          row.id,
        );
        return { run: null, row: scheduledSend(owner, sendId)! };
      }
    })
    .immediate();
}

// Worker job. The row's claim and the run it creates commit in one immediate
// transaction, and submit() reuses the stored idempotency key: a crash or a
// second worker can only find the existing run, never create another. Only a
// definite refusal marks a message failed; any other error rolls back and the
// message is tried again on the next pass.
export function deliverScheduledSends(time = now()) {
  const due = db
    .prepare(
      "SELECT id FROM scheduled_sends WHERE state='scheduled' AND send_at<=? ORDER BY send_at,rowid LIMIT 20",
    )
    .all(time) as { id: string }[];
  let submitted = 0;
  for (const { id: sendId } of due)
    db.transaction(() => {
      const row = db
        .prepare(
          "SELECT * FROM scheduled_sends WHERE id=? AND state='scheduled'",
        )
        .get(sendId) as ScheduledSend | undefined;
      if (!row) return;
      try {
        submitScheduled(row);
        submitted++;
      } catch (error) {
        const reason = refusal(error);
        if (reason === null) throw error;
        db.prepare(
          "UPDATE scheduled_sends SET state='failed',error=? WHERE id=?",
        ).run(reason, row.id);
      }
    }).immediate();
  return submitted;
}

// ---------------------------------------------------------------------------
// 7. Queue management
type QueuedRun = Pick<QueryRow<"runs">, "id" | "input" | "created_at" | "state" | "worker_id" | "active_since">;
const perConversation = (r: string) =>
  `EXISTS(SELECT 1 FROM connections c WHERE c.id=json_extract(${r}.payload,'$.connectionId') AND c.owner_id=${r}.owner_id AND ${NATIVE_CONNECTION_SQL})`;
const RANK_STEP = 1 / 1024;
function editable(run: Pick<Run, "id" | "worker_id" | "active_since"> & { state: string }) {
  return (
    run.state === "queued" &&
    run.worker_id === null &&
    !run.active_since &&
    !db.prepare("SELECT 1 FROM agent_checkpoints WHERE run_id=?").get(run.id) &&
    !db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id)
  );
}

export function reorderRun(owner: string, runId: string, body: unknown) {
  const { direction } = RunReorderInput.parse(body);
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      if (run.state !== "queued" || !run.agent_id)
        throw new Problem(409, "Only queued work can be reordered");
      const peers = queuedPeers(owner, run.id);
      const index = peers.findIndex((peer) => peer.id === run.id);
      const other = index + (direction === "up" ? -1 : 1);
      if (index < 0 || other < 0 || other >= peers.length)
        throw new Problem(409, "There is no queued message to swap with");
      if (!canSwap(peers, index, other))
        throw new Problem(
          409,
          "Messages in the same thread run in the order they were sent",
        );
      const keys = peers.map((peer) => peer.queue_key);
      const reordered = [...peers];
      [reordered[index], reordered[other]] = [
        reordered[other],
        reordered[index],
      ];
      // Keep ranks near their original times and strictly increasing, so
      // equal timestamps cannot fall back to insertion order.
      let previous = -Infinity;
      reordered.forEach((peer, position) => {
        const rank = Math.max(keys[position], previous + RANK_STEP);
        previous = rank;
        if (rank !== peer.queue_key)
          db.prepare(
            "UPDATE runs SET queue_rank=? WHERE id=? AND owner_id=? AND state='queued'",
          ).run(rank, peer.id, owner);
      });
      emit(owner, run.id, "queue.reordered", { direction });
      return { ok: true };
    })
    .immediate();
}

export function editQueuedRun(owner: string, runId: string, body: unknown) {
  const { input } = QueuedRunInput.parse(body);
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      if (!editable(run))
        throw new Problem(
          409,
          "This message has already started. It can no longer be edited.",
        );
      db.prepare(
        "UPDATE runs SET input=?,updated_at=? WHERE id=? AND owner_id=? AND state='queued' AND worker_id IS NULL",
      ).run(input, now(), run.id, owner);
      db.prepare(
        "UPDATE messages SET content=? WHERE run_id=? AND owner_id=? AND role='user'",
      ).run(input, run.id, owner);
      emit(owner, run.id, "queue.edited", {});
      return { ok: true };
    })
    .immediate();
}

/**
 * Take a queued message back into a draft: cancels it only if it has never
 * started, and returns its text so nothing is lost. A message the agent has
 * already started is never cancelled from here.
 */
export function withdrawQueuedRun(
  owner: string,
  runId: string,
  body: unknown = {},
) {
  // The files already in the draft it goes back to: the run is only
  // cancelled if its own files fit beside them.
  const { draftAttachmentIds } = RunWithdrawInput.parse(body ?? {});
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      if (
        run.kind !== "agent" ||
        !editable(run) ||
        db
          .prepare(
            "SELECT 1 FROM delegations WHERE child_run_id=? UNION ALL SELECT 1 FROM workflow_steps WHERE child_run_id=?",
          )
          .get(run.id, run.id)
      )
        throw new Problem(
          409,
          "This message has already started, so it can no longer be moved back to a draft.",
        );
      // The draft gets the message's files back too; if one is gone, the
      // message stays queued rather than come back without it.
      const ids = (run.payload.attachmentIds || []) as string[];
      const attachments = attachmentDescriptors(owner, ids);
      if (attachments.length !== ids.length)
        throw new Problem(
          409,
          "A file attached to this message is no longer available, so it was left queued.",
        );
      if (new Set([...draftAttachmentIds, ...ids]).size > MAX_MESSAGE_FILES)
        throw new Problem(
          409,
          `Your draft's files and this message's would be more than ${MAX_MESSAGE_FILES}, so it was left queued. Send or remove some files from the draft first.`,
        );
      if (!transition(run, "cancelled", { reason: "Moved back to a draft" }))
        throw new Problem(409, "This message has already started");
      return {
        input: run.input,
        agent_id: run.agent_id,
        conversation_id: run.conversation_id,
        attachment_ids: ids,
        attachments,
      };
    })
    .immediate();
}

export function moveQueuedRun(owner: string, runId: string, body: unknown) {
  const d = RunMoveInput.parse(body);
  return db
    .transaction(() => {
      const run = ownedRun(runId, owner);
      const payload = run.payload;
      const request = {
        agentId: d.agentId,
        input: run.input,
        idempotencyKey: d.idempotencyKey,
        attachmentIds: payload.attachmentIds || [],
        folderId:
          typeof payload.folderId === "string" ? payload.folderId : undefined,
        steer: false,
        personal: true,
      };
      // A repeated move returns the run the first attempt created.
      if (
        db
          .prepare("SELECT 1 FROM runs WHERE owner_id=? AND idempotency_key=?")
          .get(owner, d.idempotencyKey)
      )
        return submit(owner, request);
      if (
        run.kind !== "agent" ||
        !editable(run) ||
        db
          .prepare(
            "SELECT 1 FROM delegations WHERE child_run_id=? UNION ALL SELECT 1 FROM workflow_steps WHERE child_run_id=?",
          )
          .get(run.id, run.id)
      )
        throw new Problem(409, "Only a queued message you sent can be moved");
      if (!transition(run, "cancelled", { reason: "Moved to another agent" }))
        throw new Problem(409, "This message has already started");
      // submit() throwing rolls back the cancellation too.
      return submit(owner, request);
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// 9. Fork
export function forkConversation(
  owner: string,
  conversation: string,
  body: unknown,
) {
  const d = ConversationForkInput.parse(body);
  return db
    .transaction(() => {
      const c = ownedConversation(conversation, owner);
      const agentId = d.agentId || c.agent_id;
      if (!agentId) throw new Problem(400, "Choose an agent for the fork");
      const agent = ownedAgent(agentId, owner);
      if (!agent.connection_id)
        throw new Problem(409, "Choose an agent with a connected model");
      const target = db
        .prepare(
          "SELECT rowid seq,created_at FROM messages WHERE id=? AND owner_id=? AND conversation_id=?",
        )
        .get(d.messageId, owner, c.id) as
        { seq: number; created_at: number } | undefined;
      if (!target)
        throw new Problem(404, "Message not found in this conversation");
      const messages = parseMessages(db
        .prepare(
          `SELECT * FROM messages WHERE owner_id=? AND conversation_id=?
          AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND length(trim(content))>0
          AND (created_at<? OR (created_at=? AND rowid<=?)) ORDER BY created_at,rowid`,
        )
        .all(
          owner,
          c.id,
          target.created_at,
          target.created_at,
          target.seq,
        ));
      const forkId = id();
      // Bind the fork to the selected agent's connection now, as a first send
      // to a new conversation would.
      const connection = ownedConnection(agent.connection_id, owner);
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at,project_id,execution_connection_id) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        forkId,
        owner,
        agent.id,
        ("Fork: " + c.title).slice(0, 200),
        "loop-fork",
        null,
        now(),
        c.project_id,
        connection.id,
      );
      const insert = db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
      );
      for (const m of messages) {
        const metadata = m.metadata;
        insert.run(
          id(),
          owner,
          forkId,
          null,
          m.role,
          m.content,
          JSON.stringify(MessageMetadata.parse({
            sourceConversation: c.id,
            sourceMessage: m.id,
            forked: true,
            // Native backends start fresh sessions from these copied turns.
            selectedByUser: true,
            attachments: metadata.attachments || [],
            original: metadata,
          })),
          m.created_at,
        );
      }
      return { id: forkId, agentId: agent.id };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// 10. Usage
type Tokens = { input_tokens: number; output_tokens: number };
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
export function conversationUsage(owner: string, conversation: string) {
  ownedConversation(conversation, owner);
  const events = db
    .prepare(
      // Start with this conversation's runs, then visit only their usage
      // receipts. Polling must never scan the workspace's tool/event history.
      `SELECT e.run_id,e.type,e.payload FROM runs r CROSS JOIN events e INDEXED BY events_usage ON r.id=e.run_id AND r.owner_id=e.owner_id
      WHERE r.owner_id=? AND r.conversation_id=? AND e.type IN ('provider.receipt','native.usage') ORDER BY e.id`,
    )
    .all(owner, conversation) as {
    run_id: string;
    type: string;
    payload: string;
  }[];
  const runs: Record<string, Tokens> = {};
  const native: Record<string, Tokens> = {};
  // A provider message is one receipt with an externalId, optionally followed
  // by cumulative deltas (Anthropic message_start + message_delta). Take the
  // maximum per message so cumulative counts are not added twice.
  let segment: { run: string; tokens: Tokens } | undefined;
  const flush = () => {
    if (!segment) return;
    const total = (runs[segment.run] ||= { input_tokens: 0, output_tokens: 0 });
    total.input_tokens += segment.tokens.input_tokens;
    total.output_tokens += segment.tokens.output_tokens;
    segment = undefined;
  };
  for (const event of events) {
    let payload: { usage?: Record<string, unknown>; externalId?: unknown };
    try {
      payload = JSON.parse(event.payload);
    } catch {
      continue;
    }
    const usage = payload.usage;
    if (event.type === "native.usage") {
      if (!usage || typeof usage !== "object") continue;
      const total = (native[event.run_id] ||= {
        input_tokens: 0,
        output_tokens: 0,
      });
      total.input_tokens = Math.max(
        total.input_tokens,
        count(usage.input_tokens),
      );
      total.output_tokens = Math.max(
        total.output_tokens,
        count(usage.output_tokens),
      );
      continue;
    }
    if (payload.externalId || !segment || segment.run !== event.run_id) {
      flush();
      segment = {
        run: event.run_id,
        tokens: { input_tokens: 0, output_tokens: 0 },
      };
    }
    if (!usage || typeof usage !== "object") continue;
    const input = count(usage.input_tokens) || count(usage.prompt_tokens);
    const output = count(usage.output_tokens) || count(usage.completion_tokens);
    segment.tokens.input_tokens = Math.max(segment.tokens.input_tokens, input);
    segment.tokens.output_tokens = Math.max(
      segment.tokens.output_tokens,
      output,
    );
  }
  flush();
  Object.assign(runs, native);
  for (const [run, tokens] of Object.entries(runs))
    if (!tokens.input_tokens && !tokens.output_tokens) delete runs[run];
  const total = Object.values(runs).reduce(
    (sum, tokens) => ({
      input_tokens: sum.input_tokens + tokens.input_tokens,
      output_tokens: sum.output_tokens + tokens.output_tokens,
    }),
    { input_tokens: 0, output_tokens: 0 },
  );
  // Only runtimes that recall memory record a receipt, so the thread offers
  // "Memory used" on these runs alone.
  const memory = (
    db
      .prepare(
        `SELECT m.run_id FROM memory_receipts m JOIN runs r ON r.id=m.run_id
        WHERE r.owner_id=? AND r.conversation_id=?`,
      )
      .all(owner, conversation) as { run_id: string }[]
  ).map((row) => row.run_id);
  return { runs, total, memory };
}

// ---------------------------------------------------------------------------
// 11. Snippets
export function listSnippets(owner: string) {
  // Saving the same text twice makes two artifacts; offer it once, newest.
  // Duplicates collapse before the limit, so a run of repeated saves can't
  // push older, different snippets out of the list.
  return {
    items: db
      .prepare(
        `SELECT id,title,content,created_at FROM (
          SELECT id,title,content,created_at,rowid AS row,
            row_number() OVER (
              PARTITION BY trim(content,' '||char(9)||char(10)||char(13))
              ORDER BY created_at DESC,rowid DESC
            ) copy
          FROM artifacts WHERE owner_id=? AND archived=0
            AND (json_extract(metadata,'$.snippet')=1 OR title LIKE 'Saved prompt:%')
        ) WHERE copy=1 ORDER BY created_at DESC,row DESC LIMIT 100`,
      )
      .all(owner),
  };
}

// ---------------------------------------------------------------------------
// 12. Project summaries
export function projectSummaries(owner: string) {
  ensureWorkspaceProject(owner);
  const projects = db
    .prepare(
      "SELECT id,name FROM folders WHERE owner_id=? AND kind='project' AND parent_id IS NULL",
    )
    .all(owner) as { id: string; name: string }[];
  const byProject = <T>(sql: string) =>
    new Map(
      (
        db
          .prepare(`WITH RECURSIVE ${FOLDER_PROJECT} ${sql}`)
          .all({ owner }) as (T & { project_id: string })[]
      ).map((row) => [row.project_id, row]),
    );
  const agents = byProject<{ n: number }>(
    "SELECT fp.project_id,count(*) n FROM agents a JOIN folder_project fp ON fp.id IS a.folder_id WHERE a.owner_id=@owner AND a.retired_at IS NULL GROUP BY fp.project_id",
  );
  const runs = byProject<{ last: number; working: number; needs: number }>(
    `SELECT fp.project_id,max(r.updated_at) last,
      sum(r.state IN ('running','pausing')) working,
      sum(r.attention_dismissed_at IS NULL AND (r.state IN ('awaiting_approval','paused') OR r.state IN ('failed','interrupted'))) needs
    FROM runs r LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
    JOIN folder_project fp ON fp.id IS COALESCE(c.project_id,json_extract(r.payload,'$.folderId'))
    WHERE r.owner_id=@owner AND (r.conversation_id IS NULL OR c.id IS NOT NULL) GROUP BY fp.project_id`,
  );
  const artifacts = byProject<{ last: number }>(
    "SELECT fp.project_id,max(a.updated_at) last FROM artifacts a JOIN folder_project fp ON fp.id IS a.folder_id WHERE a.owner_id=@owner AND a.archived=0 GROUP BY fp.project_id",
  );
  const latest = byProject<{ id: string; title: string; created_at: number }>(
    `SELECT project_id,id,title,created_at FROM (
      SELECT fp.project_id,a.id,a.title,a.created_at,
        row_number() OVER (PARTITION BY fp.project_id ORDER BY p.sequence DESC) n
      FROM artifacts a JOIN artifact_publications p ON p.artifact_id=a.id
      JOIN folder_project fp ON fp.id IS a.folder_id
      LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
      WHERE a.owner_id=@owner AND a.archived=0 AND a.feed_hidden=0 AND ${resultOutputSql}
    ) WHERE n=1`,
  );
  const items = projects.map((project) => {
    const run = runs.get(project.id),
      artifact = artifacts.get(project.id),
      result = latest.get(project.id);
    const activity = Math.max(run?.last ?? 0, artifact?.last ?? 0);
    return {
      id: project.id,
      name: project.name,
      agents: agents.get(project.id)?.n ?? 0,
      last_activity_at: activity || null,
      working: run?.working ?? 0,
      needs: run?.needs ?? 0,
      latest_result: result
        ? { id: result.id, title: result.title, created_at: result.created_at }
        : null,
    };
  });
  items.sort(
    (a, b) =>
      (b.last_activity_at ?? -1) - (a.last_activity_at ?? -1) ||
      a.name.localeCompare(b.name),
  );
  return { items };
}
