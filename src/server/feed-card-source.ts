import { FEED_MESSAGE_PREFIX_LIMIT } from "../shared/cards.js";
import {
  publicRunStateSql,
  WORKING_RUN_DISPLAY_STATES_SQL,
} from "../shared/run-state.js";
import type Database from "better-sqlite3";
import { answerPredicate } from "./feed-answers.js";
import { FOLDER_PROJECT } from "./sql/folders.js";
import { INTERNAL_QUEUED_RUN_SQL } from "./sql/runs.js";
import { ResultDefectKindSchema } from "../shared/result.js";
import type { FeedRow } from "./feed-card-display.js";

const INTERNAL_MAIL_RUN_SQL = (r: string) =>
  `(json_extract(${r}.payload,'$.mailId') IS NOT NULL OR EXISTS(SELECT 1 FROM agent_mail m WHERE m.owner_id=${r}.owner_id AND ((m.run_id=${r}.id AND m.steering_id IS NULL) OR m.requeued_run_id=${r}.id)))`;

const MAIL_ORIGIN_CONTINUATION_SQL = (runIdExpr: string) => `EXISTS(
  WITH RECURSIVE ancestor(run_id, depth) AS (
    SELECT rc.parent_run_id, 1
    FROM review_continuations rc
    WHERE rc.owner_id=@owner AND rc.run_id=${runIdExpr}
    UNION ALL
    SELECT rc.parent_run_id, a.depth+1
    FROM ancestor a
    JOIN review_continuations rc ON rc.owner_id=@owner AND rc.run_id=a.run_id
    WHERE a.depth<32
  )
  SELECT 1 FROM ancestor a
  JOIN runs pr ON pr.id=a.run_id AND pr.owner_id=@owner
  WHERE ${INTERNAL_MAIL_RUN_SQL("pr")}
)`;

const HIDDEN_COMPLETED_RUN_SQL = (r: string) =>
  `(${INTERNAL_MAIL_RUN_SQL(r)} OR ${MAIL_ORIGIN_CONTINUATION_SQL(`${r}.id`)})`;

// These are write-side source reads, always limited to a single affected
// conversation. The permanent test oracle derives state from raw history
// independently of these source reads and never consults feed_cards.
const stateSql = `state_base AS MATERIALIZED (
 SELECT c.id,c.owner_id,c.title,c.agent_id,c.execution_connection_id,c.team_id,c.origin,c.project_id,
  COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id
    AND r.state IN ('running','pausing','paused','awaiting_approval') ORDER BY +r.created_at DESC,r.rowid DESC LIMIT 1),
    (SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id
      AND NOT (r.state='cancelled' AND EXISTS(SELECT 1 FROM review_continuations rc WHERE rc.owner_id=r.owner_id AND rc.run_id=r.id))
      AND NOT (r.state='queued' AND ${INTERNAL_QUEUED_RUN_SQL("r")})
      AND NOT (r.state='completed' AND ${HIDDEN_COMPLETED_RUN_SQL("r")})
      ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1),
    (SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)) feed_run_id,
  (SELECT count(*) FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='queued' AND NOT ${INTERNAL_QUEUED_RUN_SQL("r")}) feed_queued,
  COALESCE((SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed' AND NOT ${HIDDEN_COMPLETED_RUN_SQL("r")} ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
    (SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1)) feed_done_run_id,
  COALESCE((SELECT r.updated_at FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed' AND NOT ${HIDDEN_COMPLETED_RUN_SQL("r")} ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1),
    (SELECT r.updated_at FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1)) feed_done_at,
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
  ${publicRunStateSql("r")} run_state
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
  hide_internal: number;
};

const MAIL_AUTOMATION_KINDS_SQL =
  "('agent_message','agent_result','agent_ping')";
const INTERNAL_THREAD_AUTOMATION_KINDS_SQL =
  "('agent_message','agent_result','agent_ping','review_continuation')";
const RUNNING_CONTINUATION_STATES_SQL =
  "('running','pausing','paused','awaiting_approval','waiting_children')";
/**
 * Predicate matching sealed results that should stay hidden from Done, unread
 * counts, and Done reminder promotion: internal agent-to-agent mail results,
 * intermediate review-continuation turns whose follow-up is still active, and
 * parent turns superseded by a completed continuation result.
 * Uses only sealed `res.stimulus` so steered mail on a running owner turn
 * never misclassifies the owner's answer.
 */
const INTERNAL_SEALED_RESULT_SQL = (
  resAlias: string,
  internalThreadExpr: string,
) => `(
  ${internalThreadExpr}=1
  OR COALESCE(json_extract(${resAlias}.stimulus,'$.automationKind'),'') IN ${MAIL_AUTOMATION_KINDS_SQL}
  OR (${resAlias}.run_id IS NOT NULL AND ${MAIL_ORIGIN_CONTINUATION_SQL(`${resAlias}.run_id`)})
  OR (${resAlias}.run_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM review_continuations rc
    JOIN runs next_run ON next_run.id=rc.run_id AND next_run.owner_id=rc.owner_id
    WHERE rc.owner_id=@owner AND rc.parent_run_id=${resAlias}.run_id
      AND (
        (
          COALESCE(json_extract(${resAlias}.stimulus,'$.automationKind'),'')='review_continuation'
          AND (
            next_run.state IN ${RUNNING_CONTINUATION_STATES_SQL}
            OR (
              next_run.state='queued'
              AND EXISTS(
                SELECT 1 FROM agents na
                JOIN connections nc ON nc.id=json_extract(next_run.payload,'$.connectionId') AND nc.owner_id=next_run.owner_id
                WHERE na.id=next_run.agent_id AND na.owner_id=next_run.owner_id
                  AND na.retired_at IS NULL AND nc.status='connected'
              )
            )
          )
        )
        OR EXISTS(
          SELECT 1 FROM results next_res
          WHERE next_res.owner_id=@owner AND next_res.run_id=next_run.id
            AND next_res.sealed=1 AND next_res.kind IN ('run_answer','imported_answer')
        )
      )
  ))
)`;
const assistantAnswer = (run: string) =>
  `(SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=${run} AND ${answerPredicate("m")} ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1)`;
const cardSql = (doneOnly = false, resultMode = false) => `
page_run AS MATERIALIZED (
  SELECT p.*,CASE WHEN @mode='done' THEN p.done_run_id ELSE p.run_id END card_run FROM page p
),
picked AS MATERIALIZED (
  SELECT k.*,r.id card_run_id,
    ${publicRunStateSql("r")} card_run_state,
    r.error card_run_error,
    CASE WHEN res.sealed=1 THEN COALESCE(json_extract(res.stimulus,'$.text'),r.input) ELSE r.input END card_run_input,
    CASE WHEN res.sealed=1 THEN json_extract(res.provenance,'$.connectionId') ELSE json_extract(r.payload,'$.connectionId') END card_run_connection_id,
    CASE WHEN res.sealed=1 THEN json_extract(res.provenance,'$.model') ELSE json_extract(r.payload,'$.model') END card_run_model,
    CASE WHEN res.sealed=1 THEN json_extract(res.provenance,'$.resolvedModel') ELSE json_extract(r.payload,'$.resolvedModel') END card_run_resolved_model,
    r.created_at card_run_created_at,r.updated_at card_run_updated_at,
    CASE WHEN res.sealed=1 AND k.card_run IS NOT NULL THEN res.message_id WHEN k.card_run IS NOT NULL THEN ${assistantAnswer("k.card_run")} END card_answer_id,
    ${doneOnly ? "NULL" : `(SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=k.card_run ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1)`} card_any_id,
    -- Expanded Done selects its answer explicitly. An idle thread without a
    -- result has no preview, rather than showing its prompt or commentary.
    -- In mixed threads, prefer messages outside completed internal-mail runs.
    COALESCE(
      (SELECT m.id FROM messages m
        LEFT JOIN runs mr ON mr.id=m.run_id AND mr.owner_id=m.owner_id
        WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id
          AND k.expanded_done=0
          AND NOT COALESCE((mr.state='queued' AND ${INTERNAL_QUEUED_RUN_SQL("mr")}) OR (mr.state='completed' AND ${HIDDEN_COMPLETED_RUN_SQL("mr")}),0)
        ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
      (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id
        AND k.expanded_done=0
        ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1)
    ) thread_latest_id,
    CASE WHEN r.id IS NOT NULL THEN (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=k.conversation_id AND m.run_id=r.id AND m.role='user' AND json_extract(m.metadata,'$.automation.kind') IS NOT NULL ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) END trigger_id,
    CASE WHEN @mode='done' THEN 0 ELSE (SELECT count(*) FROM approvals a JOIN runs ar ON ar.id=a.run_id AND ar.owner_id=a.owner_id
      WHERE a.owner_id=@owner AND ar.conversation_id=k.conversation_id AND ar.state='awaiting_approval' AND a.state='pending' AND a.expires_at>@now) END pending_approvals,
    CASE WHEN @mode='done' THEN NULL ELSE (SELECT a.id FROM approvals a JOIN runs ar ON ar.id=a.run_id AND ar.owner_id=a.owner_id
      WHERE a.owner_id=@owner AND ar.conversation_id=k.conversation_id AND ar.state='awaiting_approval' AND a.state='pending' AND a.expires_at>@now ORDER BY a.created_at,a.rowid LIMIT 1) END approval_id,
    CASE WHEN @mode='done' THEN NULL ELSE (SELECT d.id FROM native_decisions d JOIN runs dr ON dr.id=d.run_id AND dr.owner_id=@owner
      WHERE d.conversation_id=k.conversation_id AND dr.state='awaiting_approval' AND d.state='pending' ORDER BY d.created_at LIMIT 1) END decision_id
  FROM page_run k
  LEFT JOIN runs r ON r.id=k.card_run AND r.owner_id=@owner
  LEFT JOIN results res ON @mode='done' AND res.owner_id=@owner AND res.id=k.done_card_key
),
chosen AS MATERIALIZED (
  SELECT k.*,ap.run_id approval_run_id,
    CASE
      WHEN res.sealed=1 THEN res.message_id
      WHEN @mode='done' AND k.done_message_id IS NOT NULL THEN k.done_message_id
      WHEN @mode='done' AND k.card_run IS NOT NULL THEN COALESCE(k.card_answer_id,k.card_any_id)
      WHEN k.card_run IS NOT NULL AND (@mode='working' OR (@mode='thread' AND k.card_run_state IN ${WORKING_RUN_DISPLAY_STATES_SQL})) THEN k.card_answer_id
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
  FROM picked k
  LEFT JOIN approvals ap ON ap.id=k.approval_id AND ap.owner_id=@owner
  LEFT JOIN results res ON @mode='done' AND res.owner_id=@owner AND res.id=k.done_card_key
)
SELECT k.*,
  CASE WHEN res.sealed=1 THEN json_extract(res.provenance,'$.agentName') ELSE g.name END agent_name,
  CASE WHEN res.sealed=1 THEN json_extract(res.provenance,'$.provider') ELSE g.provider END provider,
  pf.id project_id,pf.name project_name,
  m.metadata message_metadata,
  CASE WHEN res.sealed=1 THEN 'assistant' ELSE m.role END message_role,
  ${doneOnly ? "CASE WHEN res.sealed=1 THEN json_extract(res.outcome,'$.body') ELSE m.content END" : `substr(CASE WHEN res.sealed=1 THEN json_extract(res.outcome,'$.body') ELSE m.content END,1,${FEED_MESSAGE_PREFIX_LIMIT + 1})`} message_content,
  -- A sealed answer arrived when its Result was sealed. Native harnesses
  -- create the answer's message row when the turn starts and fill it in,
  -- so that row's created_at is closer to when the prompt was sent.
  CASE WHEN res.sealed=1 THEN res.created_at ELSE COALESCE(m.created_at,res.created_at) END message_created_at,
  json_extract(m.metadata,'$.automation.kind') message_automation,json_extract(m.metadata,'$.automation.fromName') message_automation_from,
  (k.message_id IS NOT NULL AND (EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.owner_id=@owner AND b.message_id=k.message_id)
    OR EXISTS(SELECT 1 FROM artifacts sa WHERE sa.owner_id=@owner AND sa.pinned=1 AND sa.archived=0 AND json_extract(sa.metadata,'$.messageId')=k.message_id))) message_saved,
  COALESCE(json_extract(res.stimulus,'$.automationKind'),json_extract(t.metadata,'$.automation.kind')) trigger_automation,
  COALESCE(json_extract(res.stimulus,'$.automationFrom'),json_extract(t.metadata,'$.automation.fromName')) trigger_automation_from,
  d.run_id decision_run_id,d.request decision_request,
  l.due_at later_due_at,l.condition later_condition,l.surfaced_at later_surfaced_at,l.created_at later_created_at,
  CASE WHEN res.sealed=1 THEN res.attachments ELSE NULL END result_attachments,
  CASE WHEN res.sealed=1 AND json_valid(res.provenance) AND json_extract(res.provenance,'$.placement.status')='recorded'
    THEN json_object('project_id',json_extract(res.provenance,'$.placement.projectId'),'project_name',json_extract(res.provenance,'$.placement.projectName')) END result_placement,
  -- Finding kinds this build presents; a newer build's are not shown.
  CASE WHEN res.sealed=1 THEN (SELECT json_group_array(f.defect) FROM (SELECT df.defect FROM result_defects df
    WHERE df.owner_id=@owner AND df.result_id=res.id AND df.defect IN (${ResultDefectKindSchema.options.map((kind) => `'${kind}'`).join(",")})
    ORDER BY df.defect) f) END result_findings,
  ${
    resultMode
      ? `CASE WHEN ${INTERNAL_SEALED_RESULT_SQL("res", "k.internal_thread")} THEN 1 ELSE 0 END`
      : "k.internal_thread"
  } hide_internal
FROM chosen k
LEFT JOIN agents g ON g.id=k.agent_id AND g.owner_id=@owner
LEFT JOIN folder_project fp ON fp.id IS k.folder_id
LEFT JOIN folders pf ON pf.id=fp.project_id AND pf.owner_id=@owner
LEFT JOIN messages m ON m.id=k.message_id AND m.owner_id=@owner
LEFT JOIN messages t ON t.id=k.trigger_id AND t.owner_id=@owner
LEFT JOIN native_decisions d ON d.id=k.decision_id
LEFT JOIN later_items l ON l.id=k.later_id AND l.owner_id=@owner
LEFT JOIN results res ON @mode='done' AND res.owner_id=@owner AND res.id=k.done_card_key
ORDER BY k.sort_at DESC,k.conversation_id DESC,k.done_card_key DESC`;

const selections = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>();

// The open reminder's surfaced time, and the conversation's newest visible
// sealed result (by time, then id), for the Done sort of the row in `flagged`.
// Hidden internal mail / superseded review results never absorb a due reminder.
const REMINDED_AT =
  "(SELECT l.surfaced_at FROM later_items l WHERE l.owner_id=@owner AND l.kind='conversation' AND l.target_id=flagged.conversation_id AND l.done_at IS NULL)";
const NEWEST_RESULT = `(SELECT n.id FROM results n WHERE n.owner_id=@owner AND n.conversation_id=flagged.conversation_id AND n.sealed=1 AND n.kind IN ('run_answer','imported_answer') AND NOT ${INTERNAL_SEALED_RESULT_SQL("n", "flagged.internal_thread")} ORDER BY n.created_at DESC,n.id DESC LIMIT 1)`;
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
    -- The published outputs are the conversation's sealed Results, attributed
    -- to their sealed author. Folders follow current organization: the folder
    -- the run ran in, otherwise the conversation's current folder.
    SELECT res.run_id run_id,res.message_id message_id,res.created_at done_at,res.id card_key,res.agent_id agent_id,
      json_extract(r.payload,'$.folderId') folder_id,
      COALESCE(json_type(r.payload,'$.folderId') IS NOT NULL,0) has_folder
    FROM results res
    LEFT JOIN runs r ON r.owner_id=res.owner_id AND r.id=res.run_id
    WHERE res.owner_id=@owner AND res.conversation_id=@conversation AND res.sealed=1
      AND res.kind IN ('run_answer','imported_answer')
      AND (@keys IS NULL OR res.id IN (SELECT value FROM json_each(@keys)))
  ), flagged AS (
    SELECT c.id conversation_id,c.title,
      ${results ? "completed.agent_id" : "c.agent_id"} agent_id,
      c.execution_connection_id,c.team_id,c.origin,
      ${folder} folder_id,c.feed_run_id run_id,c.run_state,${doneRun} done_run_id,${doneAt} done_at,
      ${results ? "completed.message_id" : "NULL"} done_message_id,${expanded ? 1 : 0} expanded_done,
      c.feed_last_activity_at last_activity_at,c.feed_queued queued,cp.position_message_id,
      (SELECT l.id FROM later_items l WHERE l.owner_id=c.owner_id AND l.kind='conversation' AND l.target_id=c.id AND l.done_at IS NULL) later_id,
      EXISTS(SELECT 1 FROM later_items l WHERE l.owner_id=c.owner_id AND l.kind='conversation' AND l.target_id=c.id AND l.done_at IS NULL AND l.surfaced_at IS NULL) snoozed,
      c.feed_queued>0 has_queued,c.approval_until,
      COALESCE(${results ? "completed.card_key," : ""}'run:'||c.feed_done_run_id,'message:'||c.feed_last_message_id,'run:'||c.feed_run_id) done_card_key,
      COALESCE(c.run_state IN ('awaiting_approval','paused') OR (c.raw_state IN ('failed','interrupted') AND c.attention_dismissed_at IS NULL),0) needs_run,
      COALESCE(c.run_state IN ${WORKING_RUN_DISPLAY_STATES_SQL},0) is_working,
      COALESCE(c.raw_state='completed',0) is_done,
      EXISTS(SELECT 1 FROM teams t WHERE t.id=c.team_id AND t.owner_id=@owner AND t.deleted_at IS NULL AND t.hide_results_from_feed=1) hide_results,
      COALESCE((
        (
          EXISTS(SELECT 1 FROM agent_mail m WHERE m.owner_id=c.owner_id AND m.recipient_conversation_id=c.id)
          OR EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id AND m.role='user' AND json_extract(m.metadata,'$.automation.kind') IN ${MAIL_AUTOMATION_KINDS_SQL})
        )
        AND NOT EXISTS(
          SELECT 1 FROM messages m
          WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id AND m.role='user'
            AND COALESCE(json_extract(m.metadata,'$.automation.kind'), '') NOT IN ${INTERNAL_THREAD_AUTOMATION_KINDS_SQL}
        )
        AND NOT EXISTS(
          SELECT 1 FROM runs r
          WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id
            AND NOT (
              json_extract(r.payload,'$.mailId') IS NOT NULL
              OR EXISTS(SELECT 1 FROM review_continuations rc WHERE rc.owner_id=r.owner_id AND rc.run_id=r.id)
              OR EXISTS(SELECT 1 FROM agent_mail m WHERE m.owner_id=r.owner_id AND ((m.run_id=r.id AND m.steering_id IS NULL) OR m.requeued_run_id=r.id))
              OR EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=r.owner_id AND m.run_id=r.id AND m.role='user' AND json_extract(m.metadata,'$.automation.kind') IN ${INTERNAL_THREAD_AUTOMATION_KINDS_SQL})
            )
        )
      ),0) internal_thread
    FROM state c ${results ? "CROSS JOIN completed_results completed" : ""}
    LEFT JOIN conversation_positions cp ON cp.owner_id=c.owner_id AND cp.conversation_id=c.id WHERE c.feed_visible=1
  ), page AS MATERIALIZED (
    -- In Done, a reminder that has come due lifts the conversation's newest
    -- card (or its idle card) back to the top; thread cards keep their order.
    -- Computed here so the stored card payload carries only sort_at.
    SELECT *,${
      results
        ? `CASE WHEN done_card_key=${NEWEST_RESULT} THEN MAX(COALESCE(done_at,last_activity_at),COALESCE(${REMINDED_AT},0)) ELSE COALESCE(done_at,last_activity_at) END`
        : done
          ? `MAX(COALESCE(done_at,last_activity_at),COALESCE(${REMINDED_AT},0))`
          : "last_activity_at"
    } sort_at,
      EXISTS(SELECT 1 FROM done_card_dismissals d WHERE d.owner_id=@owner AND d.conversation_id=flagged.conversation_id AND d.card_key=flagged.done_card_key) hidden
    FROM flagged
  ),${cardSql(expanded, results)}`;
  const statement = db.prepare(query);
  prepared.set(kind, statement);
  return statement.all(params) as SourceRow[];
}
