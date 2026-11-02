import * as feedCardsQueries from "./sql/feed-cards.js";
import * as feedCardDirtyQueries from "./sql/feed-card-dirty.js";
import type Database from "better-sqlite3";
import { displayFeedCard, feedMessagePrefix } from "./feed-card-display.js";
import { currentPull } from "./feed-card-details.js";
import type { SourceRow } from "./feed-card-source.js";
import type { StoredCard } from "./feed-projector.js";

export type { FeedFilter } from "./sql/feed-cards.js";
import type { FeedFilter, Scope } from "./sql/feed-cards.js";
type RecordRow = {
  payload: string;
  thread_payload: string;
  sort_at: number;
  conversation_id: string;
  card_key: string;
  kind?: string;
  read_at?: number | null;
  unread_version?: number;
  unread?: number;
};
// Independent SQL writers are not allowed to expose a stale projection at the
// source event watermark. Production imports db.ts in both processes; an
// out-of-band writer must restart through startup backfill before serving it.
export function assertFeedApplied(db: Database.Database) {
  if (feedCardDirtyQueries.any(db))
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
  const rows = feedCardsQueries.feedPage(db, params, filter, results);
  const { needs: needsCount, working, queued, done_unread } = rows[0];
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
    summary: { needs: needsCount, working, queued, done_unread },
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
    read?: "read" | "unread";
  },
) {
  const rows = feedCardsQueries.donePage(db, params);
  return rows.map((row) => ({
    ...display(row, "done", params.now, false, true),
    // Only results are read; an idle thread has no result to open.
    read_at: row.kind === "result" ? (row.read_at ?? null) : undefined,
    unread_version: row.kind === "result" ? row.unread_version : undefined,
  }));
}
