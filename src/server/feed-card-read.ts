import type Database from "better-sqlite3";
import { displayFeedCard, feedMessagePrefix } from "./feed-card-display.js";
import { currentPull } from "./feed-card-details.js";
import type { SourceRow } from "./feed-card-source.js";
import type { StoredCard } from "./feed-projector.js";

export type FeedFilter =
  | "all"
  | "done"
  | "replies"
  | "needs"
  | "working"
  | "queued"
  | "later"
  | "outcomes"
  | "unfinished";
type Scope = {
  owner: string;
  now: number;
  teams: string | null;
  folders: string | null;
  agent: string | null;
};
type RecordRow = {
  payload: string;
  thread_payload: string;
  sort_at: number;
  conversation_id: string;
  card_key: string;
};
const needs = "(t.needs_run OR COALESCE(t.approval_until,0)>@now)";
const idle = `NOT (${needs} OR t.working OR t.queued) AND NOT t.snoozed`;
const scope = (alias: string, params: Scope) => {
  // Parameters come from the validated route's resolved folder selection.
  const folders = params.folders
    ? (JSON.parse(params.folders) as (string | null)[])
    : null;
  const folderPredicates = folders && [
    ...(folders.some((folder) => folder !== null)
      ? [`${alias}.folder_id IN (SELECT value FROM json_each(@folders))`]
      : []),
    ...(folders.includes(null) ? [`${alias}.folder_id IS NULL`] : []),
  ];
  return [
    `${alias}.owner_id=@owner`,
    ...(params.teams
      ? [`${alias}.team_id IN (SELECT value FROM json_each(@teams))`]
      : []),
    ...(params.agent ? [`${alias}.agent_id=@agent`] : []),
    ...(folderPredicates ? [`(${folderPredicates.join(" OR ") || "0"})`] : []),
  ].join(" AND ");
};

// Independent SQL writers are not allowed to expose a stale projection at the
// source event watermark. Production imports db.ts in both processes; an
// out-of-band writer must restart through startup backfill before serving it.
export function assertFeedApplied(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM feed_card_dirty LIMIT 1").get())
    throw new Error(
      "Feed projection has uncommitted or external dirty sources",
    );
}

function display(
  record: RecordRow,
  mode: "thread" | "working" | "done",
  at: number,
  legacy: boolean,
  full: boolean,
) {
  const stored = JSON.parse(record.payload) as StoredCard;
  const thread = JSON.parse(record.thread_payload) as StoredCard;
  const card = legacy ? stored.legacy! : stored;
  const row: SourceRow = {
    ...stored.row,
    ...card.row,
    card_title: card.row.card_title,
  };
  const common = thread.row;
  // Result rows retain their historical folder/run/answer. Current context is
  // joined from the one thread row, so stream chunks never rewrite history.
  for (const key of [
    "title",
    "agent_id",
    "execution_connection_id",
    "team_id",
    "origin",
    "agent_name",
    "provider",
    "last_activity_at",
    "position_message_id",
    "later_id",
    "later_due_at",
    "later_condition",
    "later_surfaced_at",
    "queued",
  ] as const)
    (row as Record<string, unknown>)[key] = common[key];
  row.sort_at = record.sort_at;
  const approvals = thread.thread!.approvals.filter((a) => a.expires_at > at);
  row.pending_approvals = mode === "done" ? 0 : approvals.length;
  row.approval_id = mode === "done" ? null : (approvals[0]?.id ?? null);
  row.approval_run_id = mode === "done" ? null : (approvals[0]?.run_id ?? null);
  row.approval_message_id =
    mode === "done" ? null : (approvals[0]?.message_id ?? null);
  if (!full && row.message_content !== null)
    row.message_content = feedMessagePrefix(row.message_content);
  const detail = {
    ...card.detail,
    pull: currentPull(thread.thread!.watches, Date.now()),
    queued_runs: thread.thread!.queued_runs,
  };
  const item = displayFeedCard(detail, row, mode);
  if (full && item.last_message)
    item.last_message.content = row.message_content!;
  return { row, display: item };
}

export function projectionFeed(
  db: Database.Database,
  params: Scope & {
    at: number | null;
    after: string | null;
    afterCard: string | null;
  },
  filter: FeedFilter,
  results: boolean,
) {
  const mode =
    filter === "done" ? "done" : filter === "working" ? "working" : "thread";
  const sort = filter === "done" && !results ? "p.legacy_sort_at" : "p.sort_at";
  const hidden = results ? "p.hidden" : "p.legacy_hidden";
  const where = {
    replies: "0", // Explicit replies use their own immutable publication rows.
    all: "t.snoozed=0",
    done: results
      ? `(p.kind='result' OR (${idle})) AND NOT ${hidden}`
      : `(json_extract(p.payload,'$.legacy.row.done_run_id') IS NOT NULL OR NOT (${needs} OR t.working OR t.queued)) AND NOT t.snoozed AND NOT ${hidden}`,
    needs: `(t.needs_run=1 OR t.approval_until IS NOT NULL) AND ${needs}`,
    working: "t.working=1",
    queued: "t.queued=1",
    later: "t.snoozed=1",
    outcomes: "t.completed=1 AND NOT t.snoozed",
    unfinished: `(${needs} OR t.working OR t.queued) AND NOT t.snoozed`,
  }[filter];
  const sql = `SELECT p.payload,t.payload thread_payload,${sort} sort_at,p.conversation_id,p.card_key
    FROM feed_cards p ${results ? "JOIN feed_cards t ON t.owner_id=p.owner_id AND t.conversation_id=p.conversation_id AND t.kind='thread'" : ""}
    WHERE ${scope("p", params)} AND ${results ? "p.kind IN ('result','idle') AND (p.kind='result' OR (p.kind='idle' AND NOT EXISTS(SELECT 1 FROM feed_cards r WHERE r.owner_id=p.owner_id AND r.conversation_id=p.conversation_id AND r.kind='result')))" : "p.kind='thread'"}
      AND (${where})
      ${filter === "all" || filter === "done" || filter === "outcomes" ? "AND (@teams IS NOT NULL OR @agent IS NOT NULL OR NOT t.hide_results)" : ""}
      AND (@at IS NULL OR ${sort}<@at OR (${sort}=@at AND (p.conversation_id<@after OR
        (p.conversation_id=@after AND ${results ? "(@afterCard IS NULL OR p.card_key<@afterCard)" : "p.card_key<@afterCard"}))))
    ORDER BY ${sort} DESC,p.conversation_id DESC,p.card_key DESC LIMIT 41`;
  // One indexed page selection and covering-index aggregate in one statement.
  // LEFT JOIN preserves summary counts even when this continuation has no rows.
  const summarySql = `SELECT COALESCE(sum(${needs}),0) needs,
    COALESCE(sum(t.working),0) working,COALESCE(sum(t.queued),0) queued
    FROM feed_cards t WHERE t.kind='thread' AND ${scope("t", params)}`;
  type Summary = { needs: number; working: number; queued: number };
  const rows = db
    .prepare(
      `WITH summary AS (${summarySql})
    SELECT page.*,summary.needs,summary.working,summary.queued FROM summary
    LEFT JOIN (${results ? sql : sql.replace(/\bt\./g, "p.")}) page ON 1
    ORDER BY page.sort_at DESC,page.conversation_id DESC,page.card_key DESC`,
    )
    .all(params) as ((RecordRow | { payload: null }) & Summary)[];
  const { needs: needsCount, working, queued } = rows[0];
  return {
    page: rows.flatMap((row) =>
      row.payload === null
        ? []
        : [
            display(
              row,
              mode,
              params.now,
              filter === "done" && !results,
              false,
            ),
          ],
    ),
    summary: { needs: needsCount, working, queued },
  };
}

export function projectionDoneRows(
  db: Database.Database,
  params: Scope & {
    ids: string | null;
    at: number | null;
    key: string | null;
    limit: number;
    detail: boolean;
    includeDismissed: boolean;
  },
) {
  const rows = db
    .prepare(
      `SELECT p.payload,t.payload thread_payload,p.sort_at,p.conversation_id,p.card_key
    FROM feed_cards p JOIN feed_cards t ON t.owner_id=p.owner_id AND t.conversation_id=p.conversation_id AND t.kind='thread'
    WHERE ${scope("p", params)} AND p.kind IN ('result','idle') AND (p.kind='result' OR (p.kind='idle' AND NOT EXISTS(SELECT 1 FROM feed_cards r WHERE r.owner_id=p.owner_id AND r.conversation_id=p.conversation_id AND r.kind='result') AND ${idle}))
      AND (@includeDismissed OR NOT p.hidden) AND (@detail OR @teams IS NOT NULL OR @agent IS NOT NULL OR NOT t.hide_results)
      AND (@ids IS NULL OR 'd:'||COALESCE(NULLIF(p.card_key,''),'idle:'||p.conversation_id) IN (SELECT value FROM json_each(@ids)))
      AND (@at IS NULL OR (p.sort_at,p.conversation_id||char(31)||p.card_key)<(@at,@key))
    ORDER BY p.sort_at DESC,p.conversation_id DESC,p.card_key DESC LIMIT @limit`,
    )
    .all({
      ...params,
      detail: Number(params.detail),
      includeDismissed: Number(params.includeDismissed),
    }) as RecordRow[];
  return rows.map((row) => display(row, "done", params.now, false, true));
}
