import type { FeedCategory } from "../../shared/feed-categories.js";
import { traceArtifactSql } from "./artifacts.js";
import { idleFeedThreadSql } from "./feed-cards.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const ownedStatement = statement(
  "SELECT * FROM search_documents WHERE id=? AND owner_id=?",
);
const ownedRow = QueryRecords.search_documents;
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedRow, row, "search_documents");
}

export type SearchFilters = {
  agent?: string;
  folder?: string;
  /** Folders of one project (see projectFolders). */
  folders?: (string | null)[];
  kind?: string;
  from?: number;
  to?: number;
  scope?: string;
  category?: FeedCategory;
  before?: number;
};
export const eligibleText =
  "length(trim(d.title || ' ' || d.content))>0 AND NOT EXISTS(SELECT 1 FROM memory_sources ms WHERE ms.owner_id=d.owner_id AND (ms.kind||':'||ms.source_id)=d.id AND ms.eligible=1 AND ms.tombstone=0)";
export function filterSql(owner: string, filters: SearchFilters, at: number) {
  const clauses = [
      "d.owner_id=?",
      `NOT EXISTS(SELECT 1 FROM artifacts a WHERE 'artifact:'||a.id=d.id AND a.owner_id=d.owner_id AND COALESCE(${traceArtifactSql},0))`,
    ],
    params: any[] = [owner];
  for (const [key, column] of [
    ["agent", "agent_id"],
    ["folder", "folder_id"],
    ["kind", "kind"],
  ] as const) {
    if (filters[key]) {
      clauses.push(`d.${column}=?`);
      params.push(filters[key]);
    }
  }
  // A project and its subfolders. Messages retain their run's project,
  // including an explicit Workspace selection; older imports use the thread.
  if (filters.folders) {
    clauses.push(
      `EXISTS(SELECT 1 FROM json_each(?) WHERE value IS COALESCE(d.folder_id,(
        SELECT CASE WHEN json_type(mr.payload,'$.folderId') IS NOT NULL THEN json_extract(mr.payload,'$.folderId')
          ELSE COALESCE(c.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)) END
        FROM conversations c
        LEFT JOIN messages m ON substr(d.id,1,8)='message:' AND m.id=substr(d.id,9) AND m.owner_id=c.owner_id AND m.conversation_id=c.id
        LEFT JOIN runs mr ON mr.id=m.run_id AND mr.owner_id=c.owner_id AND mr.conversation_id=c.id
        WHERE c.id=d.conversation_id AND c.owner_id=d.owner_id)))`,
    );
    params.push(JSON.stringify(filters.folders));
  }
  if (filters.from) {
    clauses.push("d.created_at>=?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("d.created_at<=?");
    params.push(filters.to);
  }
  if (filters.scope === "mine")
    clauses.push(
      "EXISTS(SELECT 1 FROM messages m WHERE 'message:'||m.id=d.id AND m.owner_id=d.owner_id AND m.role='user')",
    );
  if (filters.scope === "running")
    clauses.push(
      "EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=d.owner_id AND r.agent_id=d.agent_id AND r.state IN ('running','pausing') AND r.worker_id IS NOT NULL)",
    );
  if (filters.category) {
    clauses.push(searchCategorySql(filters.category, !!filters.agent));
    if (filters.category === "done") params.push(at);
  }
  return { sql: clauses.join(" AND "), params };
}
/** Correlated to search_documents d, before either retrieval path ranks hits. */
export function searchCategorySql(category: FeedCategory, agent: boolean) {
  const visible = agent ? "1" : "NOT t.hide_results";
  const thread = `t.owner_id=d.owner_id AND t.conversation_id=d.conversation_id AND t.kind='thread'`;
  if (category === "threads")
    return `EXISTS(SELECT 1 FROM feed_cards t WHERE ${thread} AND NOT t.snoozed AND ${visible})`;

  // Documents retain their own run/message identity. A conversation can have
  // completed results, current work and queued follow-ups at the same time.
  const source = `SELECT m.run_id,m.id message_id FROM messages m
      WHERE substr(d.id,1,8)='message:' AND m.id=substr(d.id,9) AND m.owner_id=d.owner_id AND m.conversation_id=d.conversation_id
    UNION ALL
    SELECT a.run_id,json_extract(a.metadata,'$.messageId') message_id FROM artifacts a
      WHERE substr(d.id,1,9)='artifact:' AND a.id=substr(d.id,10) AND a.owner_id=d.owner_id AND a.conversation_id=d.conversation_id`;
  const notReply = `NOT EXISTS(SELECT 1 FROM steering_replies reply WHERE reply.owner_id=d.owner_id AND reply.message_id=s.message_id)`;
  if (category === "replies")
    return `EXISTS(SELECT 1 FROM (${source}) s
      JOIN steering_replies p ON p.owner_id=d.owner_id AND p.message_id=s.message_id
      WHERE p.archived_at IS NULL)`;

  if (category === "done")
    return `EXISTS(SELECT 1 FROM (${source}) s
      JOIN feed_cards p ON p.owner_id=d.owner_id AND p.conversation_id=d.conversation_id
      JOIN feed_cards t ON ${thread}
      WHERE NOT p.hidden AND ${visible} AND ${notReply} AND (
        (p.kind='result' AND (p.card_key='run:'||s.run_id OR p.card_key='message:'||s.message_id))
        OR (p.kind='idle' AND ${idleFeedThreadSql("t", "?")}
          AND NOT EXISTS(SELECT 1 FROM feed_cards r WHERE r.owner_id=p.owner_id AND r.conversation_id=p.conversation_id AND r.kind='result'))))`;

  return `EXISTS(SELECT 1 FROM (${source}) s
    JOIN feed_cards t ON ${thread}
    JOIN runs r ON r.id=s.run_id AND r.owner_id=d.owner_id AND r.conversation_id=d.conversation_id
    WHERE ${notReply} AND ${category === "working" ? "t.working=1 AND r.id=json_extract(t.payload,'$.row.run_id')" : "t.queued=1 AND r.state='queued'"})`;
}
const indexCountsStatement =
  statement(`SELECT count(*) AS total,coalesce(sum(CASE WHEN e.model=? THEN 1 ELSE 0 END),0) AS indexed
    FROM search_documents d LEFT JOIN embeddings e ON e.document_id=d.id AND e.owner_id=d.owner_id
    WHERE d.owner_id=? AND ${eligibleText}`);
const indexCountsRow = z.object({ total: z.number(), indexed: z.number() });
export function indexCounts(
  db: Database.Database,
  model: string,
  owner: string,
) {
  return parseRecord(
    indexCountsRow,
    indexCountsStatement(db).get(model, owner),
    "search_documents",
  );
}
const pendingIndexStatement = statement(
  `SELECT d.* FROM search_documents d LEFT JOIN embeddings e ON e.document_id=d.id WHERE d.owner_id=? AND (e.document_id IS NULL OR e.model<>?) AND ${eligibleText} AND d.updated_at<? ORDER BY d.updated_at,d.id LIMIT 16`,
);
export function pendingIndex(
  db: Database.Database,
  owner: string,
  model: string,
  before: number,
) {
  return pendingIndexStatement(db)
    .all(owner, model, before)
    .map((row) =>
      parseRecord(QueryRecords.search_documents, row, "search_documents"),
    );
}
