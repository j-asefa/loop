import { FOLDER_PROJECT } from "./folders.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement } from "./statement.js";

const insertStatement = statement(
  "INSERT OR IGNORE INTO message_bookmarks(owner_id,message_id,created_at) VALUES(?,?,?)",
);
export function insert(
  db: Database.Database,
  owner: string,
  message: string,
  created: number,
) {
  return insertStatement(db).run(owner, message, created);
}

const removeStatement = statement(
  "DELETE FROM message_bookmarks WHERE owner_id=? AND message_id=?",
);
export function remove(db: Database.Database, owner: string, message: string) {
  return removeStatement(db).run(owner, message);
}

const existsStatement = statement(
  "SELECT 1 FROM message_bookmarks WHERE owner_id=? AND message_id=?",
);
const existsRow = z.object({ "1": z.number() });
export function exists(db: Database.Database, owner: string, message: string) {
  const row = existsStatement(db).get(owner, message);
  return row === undefined
    ? undefined
    : parseRecord(existsRow, row, "message_bookmarks");
}

const pageStatement = statement(`WITH RECURSIVE ${FOLDER_PROJECT}
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
      WHERE b.owner_id=@owner AND (@at IS NULL OR b.created_at<@at OR (b.created_at=@at AND 'm:'||b.message_id<@key))
        AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)))
        AND (@teams IS NULL OR c.team_id IN (SELECT value FROM json_each(@teams)))
        AND (@q IS NULL OR m.content LIKE @q ESCAPE '\\' OR c.title LIKE @q ESCAPE '\\' OR l.label LIKE @q ESCAPE '\\')
      ORDER BY b.created_at DESC,key DESC LIMIT @limit`);
const pageRow = z.object({
  key: z.string(),
  saved_at: z.number(),
  message_id: z.string(),
  conversation_id: z.string(),
  conversation_title: z.string(),
  role: z.string(),
  content: z.string(),
  created_at: z.number(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  provider: z.string().nullable(),
  project_name: z.string().nullable(),
  label: z.string().nullable(),
});
export function page(
  db: Database.Database,
  params: {
    owner: string;
    at: number | null;
    key: string | null;
    limit: number;
    folders: string | null;
    teams: string | null;
    q: string | null;
  },
) {
  return pageStatement(db)
    .all(params)
    .map((row) => parseRecord(pageRow, row, "message-bookmarks"));
}

const conversationSavedStatement = statement(
  "SELECT b.message_id FROM message_bookmarks b JOIN messages m ON m.id=b.message_id AND m.owner_id=b.owner_id WHERE b.owner_id=@owner AND m.conversation_id=@conversation\n        UNION SELECT json_extract(a.metadata,'$.messageId') FROM artifacts a WHERE a.owner_id=@owner AND a.conversation_id=@conversation AND a.pinned=1 AND a.archived=0 AND json_extract(a.metadata,'$.messageId') IS NOT NULL",
);
const conversationSavedRow = QueryRecords.message_bookmarks.pick({
  message_id: true,
});
export function conversationSaved(
  db: Database.Database,
  params: { owner: string; conversation: string },
) {
  return conversationSavedStatement(db)
    .all(params)
    .map((row) => parseRecord(conversationSavedRow, row, "message_bookmarks"));
}
