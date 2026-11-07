import type Database from "better-sqlite3";
import { nonemptyAnswer } from "./feed-answers.js";
import type { FeedRow } from "./feed-card-display.js";

// These are write-side source reads, always limited to a single affected
// conversation. The permanent test oracle derives state from raw history
// independently of these source reads and never consults feed_cards.
const stateSql = `state_base AS MATERIALIZED (
 SELECT c.id,c.owner_id,c.title,c.agent_id,c.execution_connection_id,c.team_id,c.origin,c.project_id,
  COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id
    AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),
    (SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)) feed_run_id,
  (SELECT count(*) FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='queued') feed_queued,
  (SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1) feed_done_run_id,
  (SELECT r.updated_at FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1) feed_done_at,
  max(c.created_at,COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id),0),
    COALESCE((SELECT max(r.updated_at) FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id),0)) feed_last_activity_at,
  (SELECT m.id FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) feed_last_message_id,
  COALESCE(c.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)) feed_folder_id,
  (EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id)
    OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id)) feed_visible,
  (SELECT max(a.expires_at) FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    WHERE a.owner_id=c.owner_id AND a.state='pending' AND +r.conversation_id=c.id) approval_until
 FROM conversations c WHERE c.owner_id=@owner AND c.id=@conversation
), state AS MATERIALIZED (
 SELECT b.*,r.state raw_state,r.attention_dismissed_at,
  CASE WHEN r.state IN ('running','pausing') AND r.worker_id IS NULL THEN 'waiting_children' ELSE r.state END run_state
 FROM state_base b LEFT JOIN runs r ON r.id=b.feed_run_id AND r.owner_id=b.owner_id
)`;

export type SourceRow = FeedRow & {
  approval_until: number | null;
  needs_run: number;
  is_working: number;
  is_done: number;
  snoozed: number;
  has_queued: number;
  hidden: number;
  hide_results: number;
};

const FOLDER_PROJECT = `folder_project(id,project_id) AS (
  SELECT id,id FROM folders WHERE owner_id=@owner AND kind='project' AND parent_id IS NULL
  UNION
  SELECT folder_id,project_id FROM project_change_folders
    WHERE owner_id=@owner AND project_id=(SELECT project_id FROM workspace_projects WHERE owner_id=@owner)
  UNION
  SELECT f.id,p.project_id FROM folders f JOIN folder_project p ON f.parent_id=p.id
    WHERE f.owner_id=@owner AND p.project_id IS NOT (SELECT project_id FROM workspace_projects WHERE owner_id=@owner)
)`;
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

const selections = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>();

export function sourceCards(
  db: Database.Database,
  owner: string,
  conversation: string,
  kind: "thread" | "result" | "idle",
  keys: string[] | null = null,
): SourceRow[] {
  let prepared = selections.get(db);
  if (!prepared) selections.set(db, (prepared = new Map()));
  const cached = prepared.get(kind);
  const params = {
    owner,
    conversation,
    mode: kind === "thread" ? "thread" : "done",
    now: 0,
    keys: keys && JSON.stringify(keys),
  };
  if (cached) return cached.all(params) as SourceRow[];
  const results = kind === "result";
  const expanded = results || kind === "idle";
  const done = kind !== "thread";
  const doneRun = results
    ? "completed.run_id"
    : kind === "idle"
      ? "NULL"
      : "c.feed_done_run_id";
  const doneAt = results
    ? "completed.done_at"
    : kind === "idle"
      ? "NULL"
      : "c.feed_done_at";
  const folder = results
    ? "CASE WHEN completed.has_folder THEN completed.folder_id ELSE c.project_id END"
    : "c.feed_folder_id";
  const query = `WITH RECURSIVE ${FOLDER_PROJECT}, ${stateSql},
  completed_results AS (
    SELECT r.id run_id,NULL message_id,r.updated_at done_at,'run:'||r.id card_key,
      json_extract(r.payload,'$.folderId') folder_id,json_type(r.payload,'$.folderId') IS NOT NULL has_folder
    FROM runs r WHERE r.owner_id=@owner AND r.conversation_id=@conversation AND r.state='completed'
      AND (@keys IS NULL OR 'run:'||r.id IN (SELECT value FROM json_each(@keys)))
      AND EXISTS(SELECT 1 FROM messages m INDEXED BY messages_feed_answers WHERE m.owner_id=r.owner_id AND m.conversation_id=r.conversation_id
        AND m.run_id=r.id AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 AND ${nonemptyAnswer("m.content")})
    UNION ALL
    SELECT NULL,id,created_at,'message:'||id,NULL,0 FROM messages INDEXED BY messages_feed_answers
    WHERE owner_id=@owner AND conversation_id=@conversation AND run_id IS NULL AND role='assistant'
      AND (@keys IS NULL OR 'message:'||id IN (SELECT value FROM json_each(@keys)))
      AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND ${nonemptyAnswer("content")}
  ), flagged AS (
    SELECT c.id conversation_id,c.title,c.agent_id,c.execution_connection_id,c.team_id,c.origin,
      ${folder} folder_id,c.feed_run_id run_id,c.run_state,${doneRun} done_run_id,${doneAt} done_at,
      ${results ? "completed.message_id" : "NULL"} done_message_id,${expanded ? 1 : 0} expanded_done,
      c.feed_last_activity_at last_activity_at,c.feed_queued queued,cp.position_message_id,
      (SELECT l.id FROM later_items l WHERE l.owner_id=c.owner_id AND l.kind='conversation' AND l.target_id=c.id AND l.done_at IS NULL) later_id,
      EXISTS(SELECT 1 FROM later_items l WHERE l.owner_id=c.owner_id AND l.kind='conversation' AND l.target_id=c.id AND l.done_at IS NULL AND l.surfaced_at IS NULL) snoozed,
      c.feed_queued>0 has_queued,c.approval_until,
      COALESCE(${results ? "completed.card_key," : ""}'run:'||c.feed_done_run_id,'message:'||c.feed_last_message_id,'run:'||c.feed_run_id) done_card_key,
      COALESCE(c.run_state IN ('awaiting_approval','paused') OR (c.raw_state IN ('failed','interrupted') AND c.attention_dismissed_at IS NULL),0) needs_run,
      COALESCE(c.run_state IN ('running','pausing','waiting_children'),0) is_working,
      COALESCE(c.raw_state='completed',0) is_done,
      EXISTS(SELECT 1 FROM teams t WHERE t.id=c.team_id AND t.owner_id=@owner AND t.deleted_at IS NULL AND t.hide_results_from_feed=1) hide_results
    FROM state c ${results ? "CROSS JOIN completed_results completed" : ""}
    LEFT JOIN conversation_positions cp ON cp.owner_id=c.owner_id AND cp.conversation_id=c.id WHERE c.feed_visible=1
  ), page AS MATERIALIZED (
    SELECT *,${done ? "COALESCE(done_at,last_activity_at)" : "last_activity_at"} sort_at,
      EXISTS(SELECT 1 FROM done_card_dismissals d WHERE d.owner_id=@owner AND d.conversation_id=flagged.conversation_id AND d.card_key=flagged.done_card_key) hidden
    FROM flagged
  ),${cardSql(expanded)}`;
  const statement = db.prepare(query);
  prepared.set(kind, statement);
  return statement.all(params) as SourceRow[];
}
