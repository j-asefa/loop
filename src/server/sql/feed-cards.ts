import { feedOrderSql } from "../../shared/feed-order.js";
import type { FeedFilter } from "../../shared/feed-categories.js";
import {
  DONE_CARD_PREFIX,
  IDLE_DONE_KEY_PREFIX,
} from "../../shared/done-card-id.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

const hasResultStatement = statement(
  "SELECT 1 FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind='result' AND card_key=?",
);
const hasResultRow = z.object({ "1": z.number() });
export function hasResult(
  db: Database.Database,
  owner: string,
  conversation: string,
  card: string,
) {
  const row = hasResultStatement(db).get(owner, conversation, card);
  return row === undefined
    ? undefined
    : parseRecord(hasResultRow, row, "feed_cards");
}

export type Scope = {
  owner: string;
  now: number;
  teams: string | null;
  folders: string | null;
  agent: string | null;
};
const needs = "(t.needs_run OR COALESCE(t.approval_until,0)>@now)";
export const idleFeedThreadSql = (alias: string, at: string) =>
  `NOT (${alias}.needs_run OR COALESCE(${alias}.approval_until,0)>${at} OR ${alias}.working OR ${alias}.queued) AND NOT ${alias}.snoozed`;
const idle = idleFeedThreadSql("t", "@now");
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

const doneUnreadSql = (
  params: Scope,
) => `SELECT count(*) FROM feed_cards u INDEXED BY feed_cards_unread
    JOIN feed_cards ut ON ut.owner_id=u.owner_id AND ut.conversation_id=u.conversation_id AND ut.kind='thread'
    WHERE ${scope("u", params)} AND u.kind='result' AND u.unread=1 AND u.hidden=0
      AND (@teams IS NOT NULL OR @agent IS NOT NULL OR NOT ut.hide_results)`;

const feedPageStatement = statementVariants();
const donePageStatement = statementVariants();
const recordRow = z.object({
  payload: z.string(),
  thread_payload: z.string(),
  sort_at: z.number(),
  conversation_id: z.string(),
  card_key: z.string(),
});
const feedPageRow = z.union([recordRow, z.object({ payload: z.null() })]).and(
  z.object({
    needs: z.number(),
    working: z.number(),
    queued: z.number(),
    done_unread: z.number(),
  }),
);
const donePageRow = recordRow.extend({
  kind: z.string(),
  read_at: z.number().nullable(),
  unread: z.number(),
  unread_version: z.number(),
});
export function feedPage(
  db: Database.Database,
  params: Scope & {
    at: number | null;
    after: string | null;
    afterCard: string | null;
    limit: number;
  },
  filter: FeedFilter,
  results: boolean,
) {
  const sort = "p.sort_at";
  const hidden = "p.hidden";
  const where = {
    replies: "0", // Explicit replies use their own immutable publication rows.
    all: "t.snoozed=0",
    done: `(p.kind='result' OR (${idle})) AND NOT ${hidden}`,
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
        (p.conversation_id=@after AND p.card_key<@afterCard))))
    ORDER BY ${feedOrderSql({ at: sort, conversation: "p.conversation_id", card: "p.card_key" })} LIMIT @limit`;
  // One indexed page selection and covering-index aggregate in one statement.
  // LEFT JOIN preserves summary counts even when this continuation has no rows.
  const summarySql = `SELECT COALESCE(sum(${needs}),0) needs,
    COALESCE(sum(t.working),0) working,COALESCE(sum(t.queued),0) queued,
    (${doneUnreadSql(params)}) done_unread
    FROM feed_cards t WHERE t.kind='thread' AND ${scope("t", params)}`;
  const rows = feedPageStatement(
    `WITH summary AS (${summarySql})
    SELECT page.*,summary.needs,summary.working,summary.queued,summary.done_unread FROM summary
    LEFT JOIN (${results ? sql : sql.replace(/\bt\./g, "p.")}) page ON 1
    ORDER BY ${feedOrderSql({ at: "page.sort_at", conversation: "page.conversation_id", card: "page.card_key" })}`,
    db,
  )
    .all(params)
    .map((row) => parseRecord(feedPageRow, row, "feed_cards"));
  return rows;
}
export function donePage(
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
  const rows = donePageStatement(
    `SELECT p.payload,t.payload thread_payload,p.sort_at,p.conversation_id,p.card_key,p.kind,
      CASE WHEN p.kind='result' AND NOT p.unread THEN (SELECT d.read_at FROM done_card_reads d WHERE d.owner_id=p.owner_id AND d.conversation_id=p.conversation_id AND d.card_key=p.card_key) END read_at,p.unread,
      COALESCE((SELECT v.version FROM done_card_unread_versions v WHERE v.owner_id=p.owner_id AND v.conversation_id=p.conversation_id AND v.card_key=p.card_key),0) unread_version
    FROM feed_cards p JOIN feed_cards t ON t.owner_id=p.owner_id AND t.conversation_id=p.conversation_id AND t.kind='thread'
    WHERE ${scope("p", params)} AND p.kind IN ('result','idle') AND (p.kind='result' OR (p.kind='idle' AND NOT EXISTS(SELECT 1 FROM feed_cards r WHERE r.owner_id=p.owner_id AND r.conversation_id=p.conversation_id AND r.kind='result') AND ${idle}))
      AND (@includeDismissed OR NOT p.hidden) AND (@detail OR @teams IS NOT NULL OR @agent IS NOT NULL OR NOT t.hide_results)
      ${params.read ? `AND p.kind='result' AND p.unread=${params.read === "unread" ? 1 : 0}` : ""}
      AND (@ids IS NULL OR '${DONE_CARD_PREFIX}'||COALESCE(NULLIF(p.card_key,''),'${IDLE_DONE_KEY_PREFIX}'||p.conversation_id) IN (SELECT value FROM json_each(@ids)))
      AND (@at IS NULL OR (p.sort_at,p.conversation_id||char(31)||p.card_key)<(@at,@key))
    ORDER BY ${feedOrderSql({ at: "p.sort_at", conversation: "p.conversation_id", card: "p.card_key" })} LIMIT @limit`,
    db,
  )
    .all({
      ...params,
      detail: Number(params.detail),
      includeDismissed: Number(params.includeDismissed),
    })
    .map((row) => parseRecord(donePageRow, row, "feed_cards"));
  return rows;
}
