import { feedOrderSql } from "../../shared/feed-order.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";
export type ReplyScope = {
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

const unreadStatement = statement(
  `SELECT count(*) n ${replyScopeSql} AND p.read_at IS NULL`,
);
const unreadRow = z.object({ n: z.number() });
export function unread(db: Database.Database, params: ReplyScope) {
  return parseRecord(
    unreadRow,
    unreadStatement(db).get(params),
    "steering-replies",
  );
}

const pageStatement =
  statement(`SELECT p.message_id,p.created_at,p.read_at,q.id question_id,substr(q.content,1,1000) question,
    substr(m.content,1,1000) content,c.id conversation_id,c.title,c.origin,c.team_id,r.agent_id,
    ${replyFolder} folder_id,r.id run_id,r.state,r.error,r.input,r.created_at run_created_at,r.updated_at,
    json_extract(r.payload,'$.connectionId') connection_id,json_extract(r.payload,'$.model') model,
    json_extract(r.payload,'$.resolvedModel') resolved_model,json_extract(r.payload,'$.provider') provider,
    COALESCE(json_extract(r.payload,'$.name'),(SELECT name FROM agents WHERE id=r.agent_id AND owner_id=@owner)) agent_name,
    EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.owner_id=@owner AND b.message_id=m.id) saved
    ${replyScopeSql}
      AND (@at IS NULL OR (p.created_at,c.id,'reply:'||p.message_id)<(@at,@after,@afterCard))
    ORDER BY ${feedOrderSql({ at: "p.created_at", conversation: "c.id", card: "p.message_id" })} LIMIT @limit`);
const pageRow = z.object({
  message_id: z.string(),
  created_at: z.number(),
  read_at: z.number().nullable(),
  question_id: z.string(),
  question: z.string(),
  content: z.string(),
  conversation_id: z.string(),
  title: z.string(),
  origin: z.string(),
  team_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  folder_id: z.string().nullable(),
  run_id: z.string(),
  state: z.string(),
  error: z.string().nullable(),
  input: z.string(),
  run_created_at: z.number(),
  updated_at: z.number(),
  connection_id: z.string().nullable(),
  model: z.string().nullable(),
  resolved_model: z.string().nullable(),
  provider: z.string().nullable(),
  agent_name: z.string().nullable(),
  saved: z.number(),
});
export function page(
  db: Database.Database,
  params: ReplyScope & {
    at: number | null;
    after: string | null;
    afterCard: string | null;
    limit: number;
  },
) {
  return pageStatement(db)
    .all(params)
    .map((row) => parseRecord(pageRow, row, "steering-replies"));
}

const insertStatement = statement(
  "INSERT INTO steering_replies(message_id,owner_id,steering_id,created_at)\n      VALUES(?,?,?,?)",
);
export function insert(
  db: Database.Database,
  message: string,
  owner: string,
  steering: string,
  created: number,
) {
  return insertStatement(db).run(message, owner, steering, created);
}

const ownedMessageStatement = statement(
  "SELECT p.message_id FROM steering_replies p\n      JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id\n      WHERE p.owner_id=? AND p.message_id=?",
);
const ownedMessageRow = QueryRecords.steering_replies.pick({
  message_id: true,
});
export function ownedMessage(
  db: Database.Database,
  owner: string,
  message: string,
) {
  const row = ownedMessageStatement(db).get(owner, message);
  return row === undefined
    ? undefined
    : parseRecord(ownedMessageRow, row, "steering_replies");
}

const setReadArchiveStatement = statement(
  "UPDATE steering_replies SET\n      read_at=CASE WHEN @read THEN COALESCE(read_at,@at) ELSE read_at END,\n      archived_at=CASE WHEN @archive IS NULL THEN archived_at WHEN @archive THEN COALESCE(archived_at,@at) ELSE NULL END\n      WHERE owner_id=@owner AND message_id=@id",
);
export function setReadArchive(
  db: Database.Database,
  params: {
    owner: string;
    id: string;
    at: number;
    read: number;
    archive: number | null;
  },
) {
  return setReadArchiveStatement(db).run(params);
}
