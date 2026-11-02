import { cardRow, type CardQuerySelection } from "./artifacts.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { QueryRecords } from "../query-records.js";
import { parseRecord } from "../row-schemas.js";
import { statement, statementVariants } from "./statement.js";

// Use with the messages alias `m` at model-context and attachment boundaries.
// Owner-visible history retains refused/cancelled mail, but it cannot become
// a later model input or grant file access through that retained message.
// A terminal failure can occur before provider dispatch. Only active or
// completed deliveries authorize these passive reads; uncertainty does not.
export const READABLE_MAIL_SQL = `(json_extract(m.metadata,'$.automation.mailId') IS NULL OR EXISTS(
  SELECT 1 FROM agent_mail mail JOIN runs delivery ON delivery.id=m.run_id AND delivery.owner_id=m.owner_id
  WHERE mail.id=json_extract(m.metadata,'$.automation.mailId') AND mail.owner_id=m.owner_id
    AND mail.state='sent' AND delivery.state IN ('running','pausing','awaiting_approval','completed')
    AND NOT EXISTS(SELECT 1 FROM run_steering s WHERE s.message_id=m.id AND s.state<>'delivered')
))`;

const insertStatement = statement(
  "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
);
export function insert(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  conversation: string | null,
  run: string | null,
  role: string | null,
  content: string | null,
  metadata: string | null,
  created: number,
) {
  return insertStatement(db).run(
    id,
    owner,
    conversation,
    run,
    role,
    content,
    metadata,
    created,
  );
}

const agentHistoryStatement = statement(
  `SELECT m.* FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND m.owner_id=? AND m.role IN ('user','assistant') AND json_extract(m.metadata,'$.progress') IS NOT 1 AND ${READABLE_MAIL_SQL} AND (m.run_id IS NULL OR r.rowid <= (SELECT rowid FROM runs WHERE id=?)) AND NOT EXISTS(SELECT 1 FROM run_steering s WHERE s.message_id=m.id AND (s.run_id=? OR s.state<>'delivered')) ORDER BY COALESCE(r.created_at,m.created_at),r.rowid,CASE m.role WHEN 'user' THEN 0 ELSE 1 END,m.rowid`,
);
const agentHistoryRow = QueryRecords.messages;
export function agentHistory(
  db: Database.Database,
  conversation: string | null,
  owner: string | null,
  run: string | null,
  steeringRun: string | null,
) {
  return agentHistoryStatement(db)
    .all(conversation, owner, run, steeringRun)
    .map((row) => parseRecord(agentHistoryRow, row, "messages"));
}

const insertAssistantPlaceholderStatement = statement(
  "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','',?,?)",
);
export function insertAssistantPlaceholder(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  conversation: string | null,
  run: string | null,
  metadata: string | null,
  created: number,
) {
  return insertAssistantPlaceholderStatement(db).run(
    id,
    owner,
    conversation,
    run,
    metadata,
    created,
  );
}

const updateContentAndMetadataStatement = statement(
  "UPDATE messages SET content=?,metadata=? WHERE id=?",
);
export function updateContentAndMetadata(
  db: Database.Database,
  content: string | null,
  metadata: string | null,
  id: string | null,
) {
  return updateContentAndMetadataStatement(db).run(content, metadata, id);
}

const mailMessageIdStatement = statement(
  "SELECT id FROM messages WHERE owner_id=? AND conversation_id=? AND run_id IN (?,?) AND json_extract(metadata,'$.automation.mailId')=? ORDER BY created_at,id LIMIT 1",
);
const mailMessageIdRow = QueryRecords.messages.pick({ id: true });
export function mailMessageId(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
  run: string | null,
  requeuedRun: string | null,
  mail: string | null,
) {
  const row = mailMessageIdStatement(db).get(
    owner,
    conversation,
    run,
    requeuedRun,
    mail,
  );
  return row === undefined
    ? undefined
    : parseRecord(mailMessageIdRow, row, "messages");
}

const selectedContextStatement = statement(
  "SELECT role,content FROM messages WHERE conversation_id=? AND json_extract(metadata,'$.selectedByUser')=1 ORDER BY created_at,rowid",
);
const selectedContextRow = QueryRecords.messages.pick({
  role: true,
  content: true,
});
export function selectedContext(
  db: Database.Database,
  conversation: string | null,
) {
  return selectedContextStatement(db)
    .all(conversation)
    .map((row) => parseRecord(selectedContextRow, row, "messages"));
}

const continuationPositionsStatement = statement(
  "SELECT id,rowid seq FROM messages WHERE owner_id=? AND conversation_id=? AND id IN (SELECT value FROM json_each(?))",
);
const continuationPositionsRow = z.object({ id: z.string(), seq: z.number() });
export function continuationPositions(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
  ids: string | null,
) {
  return continuationPositionsStatement(db)
    .all(owner, conversation, ids)
    .map((row) => parseRecord(continuationPositionsRow, row, "messages"));
}

const searchStatement = statement(
  "SELECT * FROM messages WHERE owner_id=? AND instr(lower(content),lower(?))>0 ORDER BY created_at DESC LIMIT 50",
);
const searchRow = QueryRecords.messages;
export function search(
  db: Database.Database,
  owner: string | null,
  query: string | null,
) {
  return searchStatement(db)
    .all(owner, query)
    .map((row) => parseRecord(searchRow, row, "messages"));
}

const insertWithDefaultMetadataStatement = statement(
  "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)",
);
export function insertWithDefaultMetadata(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  conversation: string | null,
  run: string | null,
  role: string | null,
  content: string | null,
  created: number,
) {
  return insertWithDefaultMetadataStatement(db).run(
    id,
    owner,
    conversation,
    run,
    role,
    content,
    created,
  );
}

const latestAssistantContentStatement = statement(
  "SELECT content FROM messages WHERE owner_id=? AND run_id=? AND role='assistant' AND length(trim(content))>0 ORDER BY created_at DESC,rowid DESC LIMIT 1",
);
const latestAssistantContentRow = QueryRecords.messages.pick({ content: true });
export function latestAssistantContent(
  db: Database.Database,
  owner: string | null,
  run: string | null,
) {
  const row = latestAssistantContentStatement(db).get(owner, run);
  return row === undefined
    ? undefined
    : parseRecord(latestAssistantContentRow, row, "messages");
}

const ownedMetadataStatement = statement(
  "SELECT metadata FROM messages WHERE id=? AND owner_id=?",
);
const ownedMetadataRow = QueryRecords.messages.pick({ metadata: true });
export function ownedMetadata(
  db: Database.Database,
  id: string | null,
  owner: string | null,
) {
  const row = ownedMetadataStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(ownedMetadataRow, row, "messages");
}

const replyContextStatement =
  statement(`SELECT m.content,m.created_at,a.name,m.role='user' AS mine FROM messages m
        JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
        JOIN agents a ON a.id=c.agent_id AND a.owner_id=c.owner_id
        WHERE m.owner_id=? AND c.agent_id=? AND m.conversation_id=? AND m.id=?
          AND m.role IN ('assistant','user') AND json_extract(m.metadata,'$.partial') IS NOT 1
          AND length(trim(m.content))>0`);
const replyContextRow = z.object({
  content: z.string(),
  created_at: z.number(),
  name: z.string(),
  mine: z.number(),
});
export function replyContext(
  db: Database.Database,
  owner: string | null,
  agent: string | null,
  conversation: string | null,
  message: string | null,
) {
  const row = replyContextStatement(db).get(
    owner,
    agent,
    conversation,
    message,
  );
  return row === undefined
    ? undefined
    : parseRecord(replyContextRow, row, "messages");
}

const insertImportedStatement = statement(
  "INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?)",
);
export function insertImported(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  conversation: string | null,
  role: string | null,
  content: string | null,
  metadata: string | null,
  created: number,
) {
  return insertImportedStatement(db).run(
    id,
    owner,
    conversation,
    role,
    content,
    metadata,
    created,
  );
}

const forkPositionStatement = statement(
  "SELECT rowid seq,created_at FROM messages WHERE id=? AND owner_id=? AND conversation_id=?",
);
const forkPositionRow = z.object({ seq: z.number(), created_at: z.number() });
export function forkPosition(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  conversation: string | null,
) {
  const row = forkPositionStatement(db).get(id, owner, conversation);
  return row === undefined
    ? undefined
    : parseRecord(forkPositionRow, row, "messages");
}

const forkHistoryStatement =
  statement(`SELECT * FROM messages WHERE owner_id=? AND conversation_id=?
          AND COALESCE(json_extract(metadata,'$.progress'),0)=0 AND length(trim(content))>0
          AND (created_at<? OR (created_at=? AND rowid<=?)) ORDER BY created_at,rowid`);
const forkHistoryRow = QueryRecords.messages;
export function forkHistory(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
  before: number,
  at: number,
  seq: number,
) {
  return forkHistoryStatement(db)
    .all(owner, conversation, before, at, seq)
    .map((row) => parseRecord(forkHistoryRow, row, "messages"));
}

const latestContentStatement = statement(
  "SELECT substr(content,1,4000) content FROM messages WHERE owner_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
);
const latestContentRow = QueryRecords.messages.pick({ content: true });
export function latestContent(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
) {
  const row = latestContentStatement(db).get(owner, conversation);
  return row === undefined
    ? undefined
    : parseRecord(latestContentRow, row, "messages");
}

const outlineStatement = statement(
  "SELECT id,run_id,role,substr(content,1,1000) content,created_at,rowid seq FROM messages WHERE owner_id=? AND conversation_id=? AND json_extract(metadata,'$.progress') IS NOT 1 ORDER BY created_at,rowid",
);
const outlineRow = QueryRecords.messages
  .pick({ id: true, run_id: true, role: true, content: true, created_at: true })
  .extend({ seq: z.number() });
export function outline(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
) {
  return outlineStatement(db)
    .all(owner, conversation)
    .map((row) => parseRecord(outlineRow, row, "messages"));
}

const editRunUserContentStatement = statement(
  "UPDATE messages SET content=? WHERE run_id=? AND owner_id=? AND role='user'",
);
export function editRunUserContent(
  db: Database.Database,
  content: string | null,
  run: string | null,
  owner: string | null,
) {
  return editRunUserContentStatement(db).run(content, run, owner);
}

const conversationPositionStatement = statement(
  "SELECT id,created_at FROM messages WHERE id=? AND owner_id=? AND conversation_id=?",
);
const conversationPositionRow = QueryRecords.messages.pick({
  id: true,
  created_at: true,
});
export function conversationPosition(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  conversation: string | null,
) {
  const row = conversationPositionStatement(db).get(id, owner, conversation);
  return row === undefined
    ? undefined
    : parseRecord(conversationPositionRow, row, "messages");
}

const deleteRunUpdateStatement = statement(
  "DELETE FROM messages WHERE owner_id=? AND run_id=? AND update_key=?",
);
export function deleteRunUpdate(
  db: Database.Database,
  owner: string | null,
  run: string | null,
  key: string | null,
) {
  return deleteRunUpdateStatement(db).run(owner, run, key);
}

const nativeTransferHistoryStatement = statement(
  `SELECT m.role,m.content FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND m.role IN ('user','assistant') AND json_extract(m.metadata,'$.progress') IS NOT 1 AND ${READABLE_MAIL_SQL} AND m.content<>'' AND (m.run_id IS NULL OR r.rowid<(SELECT rowid FROM runs WHERE id=?)) ORDER BY COALESCE(r.created_at,m.created_at),r.rowid,CASE m.role WHEN 'user' THEN 0 ELSE 1 END,m.rowid`,
);
const nativeTransferHistoryRow = QueryRecords.messages.pick({
  role: true,
  content: true,
});
export function nativeTransferHistory(
  db: Database.Database,
  conversation: string | null,
  run: string | null,
) {
  return nativeTransferHistoryStatement(db)
    .all(conversation, run)
    .map((row) => parseRecord(nativeTransferHistoryRow, row, "messages"));
}

const insertNativePlaceholderStatement = statement(
  "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','','{}',?)",
);
export function insertNativePlaceholder(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  conversation: string | null,
  run: string | null,
  created: number,
) {
  return insertNativePlaceholderStatement(db).run(
    id,
    owner,
    conversation,
    run,
    created,
  );
}

const publishedReplyStatement =
  statement(`SELECT m.id,m.content,json_extract(m.metadata,'$.reply.to') reply_to
      FROM messages m JOIN steering_replies p ON p.message_id=m.id AND p.owner_id=m.owner_id
      WHERE m.owner_id=? AND m.run_id=? AND m.update_key=?`);
const publishedReplyRow = QueryRecords.messages
  .pick({ id: true, content: true })
  .extend({ reply_to: z.string().nullable() });
export function publishedReply(
  db: Database.Database,
  owner: string | null,
  run: string | null,
  message: string | null,
) {
  const row = publishedReplyStatement(db).get(owner, run, message);
  return row === undefined
    ? undefined
    : parseRecord(publishedReplyRow, row, "messages");
}

const insertUserStatement = statement(
  "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user',?,?,?)",
);
export function insertUser(
  db: Database.Database,
  id: string | null,
  owner: string | null,
  conversation: string | null,
  run: string | null,
  content: string | null,
  metadata: string | null,
  created: number,
) {
  return insertUserStatement(db).run(
    id,
    owner,
    conversation,
    run,
    content,
    metadata,
    created,
  );
}

const sharedAttachmentReadableStatement = statement(
  `SELECT 1 FROM messages m, json_each(m.metadata,'$.attachments') a WHERE m.owner_id=? AND m.conversation_id=? AND json_extract(a.value,'$.id')=? AND ${READABLE_MAIL_SQL}`,
);
const sharedAttachmentReadableRow = z.object({ "1": z.number() });
export function sharedAttachmentReadable(
  db: Database.Database,
  owner: string | null,
  conversation: string | null,
  file: string,
) {
  const row = sharedAttachmentReadableStatement(db).get(
    owner,
    conversation,
    file,
  );
  return row === undefined
    ? undefined
    : parseRecord(sharedAttachmentReadableRow, row, "messages");
}

const mailContentReadableStatement =
  statement(`SELECT 1 FROM messages m WHERE m.owner_id=? AND m.run_id IN (?,?)
       AND json_extract(m.metadata,'$.automation.mailId')=? AND ${READABLE_MAIL_SQL} LIMIT 1`);
const mailContentReadableRow = z.object({ "1": z.number() });
export function mailContentReadable(
  db: Database.Database,
  owner: string,
  run: string | null,
  requeued: string | null,
  mail: string,
) {
  const row = mailContentReadableStatement(db).get(owner, run, requeued, mail);
  return row === undefined
    ? undefined
    : parseRecord(mailContentReadableRow, row, "messages");
}

const agentOutputPageStatement = statement(`WITH entries AS (
    SELECT m.id,m.content,COALESCE((SELECT f.created_at FROM messages f
        WHERE json_extract(m.metadata,'$.progress') IS NOT 1
          AND f.owner_id=m.owner_id AND f.run_id=m.run_id AND f.update_key IS NOT NULL
          AND json_extract(f.metadata,'$.final')=1
        ORDER BY f.rowid DESC LIMIT 1),m.created_at) created_at,m.conversation_id,m.run_id,
      CASE WHEN json_extract(m.metadata,'$.progress')=1 THEN 0 ELSE 1 END final
    FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
    WHERE m.owner_id=? AND c.agent_id=? AND m.role='assistant'
      AND json_extract(m.metadata,'$.partial') IS NOT 1
      AND NOT (json_extract(m.metadata,'$.progress') IS 1 AND json_extract(m.metadata,'$.final') IS 1)
      AND length(trim(m.content))>0
    ) SELECT *, (SELECT json_extract(r.payload,'$.model') FROM runs r WHERE r.id=entries.run_id AND r.owner_id=?) model FROM entries WHERE (created_at,final,id)<(?,?,?)
    ORDER BY created_at DESC,final DESC,id DESC LIMIT 51`);
const agentOutputPageRow = QueryRecords.messages
  .pick({
    id: true,
    content: true,
    created_at: true,
    conversation_id: true,
    run_id: true,
  })
  .extend({ final: z.number(), model: z.string().nullable() });
export function agentOutputPage(
  db: Database.Database,
  owner: string,
  agent: string,
  modelOwner: string,
  before: number,
  final: number,
  id: string,
) {
  return agentOutputPageStatement(db)
    .all(owner, agent, modelOwner, before, final, id)
    .map((row) => parseRecord(agentOutputPageRow, row, "messages"));
}

const upsertConversationUpdateStatement = statement(`INSERT INTO messages(
    id,owner_id,conversation_id,run_id,role,content,metadata,created_at,update_key)
    SELECT ?,r.owner_id,r.conversation_id,r.id,'assistant',?,?,?,?
    FROM runs r JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
    WHERE r.id=? AND r.owner_id=?
    ON CONFLICT(owner_id,run_id,update_key) DO UPDATE SET
      content=excluded.content,metadata=excluded.metadata
    RETURNING id`);
const upsertConversationUpdateRow = QueryRecords.messages.pick({ id: true });
export function upsertConversationUpdate(
  db: Database.Database,
  id: string,
  content: string,
  metadata: string,
  created: number,
  key: string,
  run: string,
  owner: string,
) {
  const row = upsertConversationUpdateStatement(db).get(
    id,
    content,
    metadata,
    created,
    key,
    run,
    owner,
  );
  return row === undefined
    ? undefined
    : parseRecord(upsertConversationUpdateRow, row, "messages");
}

const memoryCandidatesStatement =
  statement(`SELECT m.*,c.project_id,c.title,c.agent_id,r.state FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN runs r ON r.id=m.run_id
      WHERE m.role IN ('user','assistant') AND json_extract(m.metadata,'$.progress') IS NOT 1 AND ${READABLE_MAIL_SQL} AND (r.state IN ('completed','failed','cancelled') OR m.run_id IS NULL) AND NOT EXISTS(SELECT 1 FROM memory_sources s WHERE s.owner_id=m.owner_id AND s.kind='message' AND s.source_id=m.id AND s.updated_at>=m.created_at AND s.content_hash IS NOT NULL AND s.content=m.content) LIMIT 250`);
const memoryCandidatesRow = QueryRecords.messages.extend({
  project_id: z.string().nullable(),
  title: z.string(),
  agent_id: z.string().nullable(),
  state: z.string().nullable(),
});
export function memoryCandidates(db: Database.Database) {
  return memoryCandidatesStatement(db)
    .all()
    .map((row) => parseRecord(memoryCandidatesRow, row, "messages"));
}

const laterTargetStatement =
  statement(`SELECT m.id,substr(m.content,1,4000) content,m.conversation_id,c.title,a.name agent_name,a.provider,
        r.input card_run_input,r.state card_run_state,
        CASE WHEN m.role='assistant' AND json_extract(m.metadata,'$.reply.published')=1 THEN (
          SELECT q.content FROM messages q WHERE q.id=json_extract(m.metadata,'$.reply.to')
          AND q.owner_id=m.owner_id AND q.conversation_id=m.conversation_id AND q.run_id=m.run_id AND q.role='user'
        ) END reply_prompt,
        COALESCE(json_extract(r.payload,'$.folderId'),c.project_id) folder_id
        FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
        LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id AND r.conversation_id=m.conversation_id
        LEFT JOIN agents a ON a.id=c.agent_id AND a.owner_id=c.owner_id WHERE m.id=? AND m.owner_id=?`);
const laterTargetRow = QueryRecords.messages
  .pick({ id: true, content: true, conversation_id: true })
  .extend({
    title: z.string(),
    agent_name: z.string().nullable(),
    provider: z.string().nullable(),
    card_run_input: z.string().nullable(),
    card_run_state: z.string().nullable(),
    reply_prompt: z.string().nullable(),
    folder_id: z.string().nullable(),
  });
export function laterTarget(db: Database.Database, id: string, owner: string) {
  const row = laterTargetStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(laterTargetRow, row, "messages");
}

const threadMatchesStatement =
  statement(`SELECT m.id,m.role,m.run_id,m.content,m.created_at,
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
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 100`);
const threadMatchesRow = QueryRecords.messages
  .pick({ id: true, role: true, run_id: true, content: true, created_at: true })
  .extend({
    progress: z.union([z.number(), z.string()]),
    run_state: z.string().nullable(),
    run_error: z.string().nullable(),
    final: z.number().nullable(),
    last: z.number().nullable(),
  });
export function threadMatches(
  db: Database.Database,
  bindings: { owner: string; conversation: string; q: string },
) {
  return threadMatchesStatement(db)
    .all(bindings)
    .map((row) => parseRecord(threadMatchesRow, row, "messages"));
}

const runAttachmentReadableStatement =
  statement(`SELECT 1 FROM messages m, json_each(m.metadata,'$.attachments') a
    WHERE m.owner_id=? AND m.conversation_id=? AND json_extract(a.value,'$.id')=? AND ${READABLE_MAIL_SQL}
    AND (m.run_id IS NULL OR (SELECT rowid FROM runs WHERE id=m.run_id)<=(SELECT rowid FROM runs WHERE id=?))`);
const runAttachmentReadableRow = z.object({ "1": z.number() });
export function runAttachmentReadable(
  db: Database.Database,
  owner: string,
  conversation: string | null,
  file: string,
  run: string,
) {
  const row = runAttachmentReadableStatement(db).get(
    owner,
    conversation,
    file,
    run,
  );
  return row === undefined
    ? undefined
    : parseRecord(runAttachmentReadableRow, row, "messages");
}

const existsInConversationStatement = statement(
  "SELECT 1 FROM messages WHERE id=? AND owner_id=? AND conversation_id=?",
);
const existsInConversationRow = z.object({ "1": z.number() });
export function existsInConversation(
  db: Database.Database,
  id: string,
  owner: string,
  conversation: string,
) {
  const row = existsInConversationStatement(db).get(id, owner, conversation);
  return row === undefined
    ? undefined
    : parseRecord(existsInConversationRow, row, "messages");
}

const ownedStatement = statement(
  "SELECT * FROM messages WHERE id=? AND owner_id=?",
);
export function owned(db: Database.Database, id: string, owner: string) {
  const row = ownedStatement(db).get(id, owner);
  return row === undefined
    ? undefined
    : parseRecord(QueryRecords.messages, row, "messages");
}

const promptStatements = statementVariants();
const promptRow = QueryRecords.messages.extend({
  run_state: z.string().nullable(),
  run_error: z.string().nullable(),
  cursor: z.number(),
  agent_id: z.string().nullable(),
  team_id: z.string().nullable(),
  name: z.string().nullable(),
  provider: z.string().nullable(),
});
export function promptPage(
  db: Database.Database,
  shape: {
    teamCount: number;
    folder: boolean;
    agent: boolean;
    cursor: boolean;
  },
  values: unknown[],
) {
  let filter = "m.owner_id=? AND m.role='user'";
  if (shape.teamCount)
    filter +=
      " AND c.team_id IN (" +
      Array.from({ length: shape.teamCount }, () => "?").join(",") +
      ")";
  if (shape.folder)
    filter +=
      " AND EXISTS (SELECT 1 FROM runs fr WHERE fr.id=m.run_id AND EXISTS(SELECT 1 FROM json_each(?) WHERE value IS json_extract(fr.payload,'$.folderId')))";
  if (shape.agent) filter += " AND c.agent_id=?";
  if (shape.cursor) filter += " AND m.rowid<?";
  return promptStatements(
    `SELECT m.*,r.state run_state,r.error run_error,m.rowid cursor,c.agent_id,c.team_id,a.name,a.provider FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agents a ON a.id=c.agent_id WHERE ${filter} ORDER BY m.rowid DESC LIMIT 40`,
    db,
  )
    .all(...values)
    .map((row) => parseRecord(promptRow, row, "messages"));
}

const pullReferencesStatement =
  statement(`SELECT content,created_at FROM messages
    WHERE owner_id=? AND conversation_id=? AND role IN ('user','assistant')
      AND instr(content,'github.com/')>0 ORDER BY created_at DESC,rowid DESC`);
const pullReferenceRow = QueryRecords.messages.pick({
  content: true,
  created_at: true,
});
export function* pullReferences(
  db: Database.Database,
  owner: string,
  conversation: string,
) {
  for (const row of pullReferencesStatement(db).iterate(owner, conversation))
    yield parseRecord(pullReferenceRow, row, "messages");
}

// Prompts you sent yourself: user messages of your own agent runs, not
// delegated, imported or forwarded ones. Shared by the list and its count.
const PROMPTS_WITH = `WITH RECURSIVE folder_project(id,owner_id,project_id) AS (
      SELECT id,owner_id,id FROM folders WHERE kind='project' AND parent_id IS NULL
      UNION ALL
      SELECT f.id,f.owner_id,p.project_id FROM folders f
      JOIN folder_project p ON f.parent_id=p.id AND f.owner_id=p.owner_id
    )`;
export const personalMessageSql = `m.role='user'
    AND r.id IS NOT NULL AND r.conversation_id=c.id
    AND (c.project_id IS NULL OR EXISTS(SELECT 1 FROM folders p WHERE p.id=c.project_id AND p.owner_id=m.owner_id))
    AND (json_extract(m.metadata,'$.personal')=1 OR (
      json_type(m.metadata,'$.personal') IS NULL
      AND json_type(m.metadata,'$.attachments')='array'
      AND json_type(m.metadata,'$.backend') IS NULL
      AND json_type(m.metadata,'$.sourceMessage') IS NULL
      AND r.kind='agent'
      AND NOT EXISTS(SELECT 1 FROM delegations d WHERE d.child_run_id=r.id)
    ))`;
const PROMPTS_FROM = `    FROM messages m
    JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
    JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id AND r.conversation_id=c.id
    LEFT JOIN agents a ON a.id=r.agent_id AND a.owner_id=m.owner_id
    LEFT JOIN folder_project fp ON fp.id=COALESCE(json_extract(r.payload,'$.folderId'),c.project_id) AND fp.owner_id=m.owner_id
    LEFT JOIN folders project ON project.id=fp.project_id AND project.owner_id=m.owner_id
    WHERE m.owner_id=? AND ${personalMessageSql}`;

const personalRow = z.object({
  id: z.string(),
  content: z.string(),
  created_at: z.number(),
  conversation_id: z.string(),
  attachments: z.string().nullable(),
  conversation_title: z.string(),
  agent_name: z.string().nullable(),
  provider: z.string().nullable(),
  agent_id: z.string().nullable(),
  project_name: z.string().nullable(),
});

const personalHistoryStatement = statement(`${PROMPTS_WITH}
    SELECT m.id,m.content,m.created_at,m.conversation_id,
    json_extract(m.metadata,'$.attachments') attachments,c.title conversation_title,
    a.name agent_name,a.provider,a.id agent_id,project.name project_name
${PROMPTS_FROM}
    AND (? IS NULL OR instr(lower(m.content),lower(?))>0)
    AND (m.created_at,m.id)<(?,?)
    ORDER BY m.created_at DESC,m.id DESC LIMIT 51`);
const personalHistorySelection = personalRow;
export function personalHistory(
  db: Database.Database,
  ...bindings: [
    owner: string,
    query: string | null,
    matchingQuery: string | null,
    before: number,
    id: string,
  ]
) {
  return personalHistoryStatement(db)
    .all(...bindings)
    .map((row) => parseRecord(personalHistorySelection, row, "messages"));
}

const personalCountStatement = statement(
  `${PROMPTS_WITH}\n    SELECT count(*) n\n${PROMPTS_FROM}`,
);
const personalCountSelection = z.object({ n: z.number() });
export function personalCount(
  db: Database.Database,
  ...bindings: [owner: string]
) {
  const row = personalCountStatement(db).get(...bindings);
  return parseRecord(personalCountSelection, row, "messages");
}

export const savedMessageCardSql = `b.message_id IS NOT NULL`;

const cardsStatement = statementVariants();
const projects = `WITH card_projects(folder_id,project_id) AS (
  SELECT folder_id,project_id FROM project_change_folders WHERE owner_id=@owner
)`;

export function cards(
  db: Database.Database,
  owner: string,
  options: CardQuerySelection,
  {
    ids,
    before,
    limit = 100,
  }: { ids?: string[]; before?: [number, string] | null; limit?: number } = {},
) {
  if (ids && !ids.length) return [];
  if (options.view === "results") return [];
  const folder = "COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)";
  const agent = `CASE WHEN ${personalMessageSql} THEN r.agent_id ELSE COALESCE(r.agent_id,c.agent_id) END`;
  const filterAgent = `CASE WHEN ${personalMessageSql} THEN r.agent_id END`;
  const source = "m";
  const key = `'m:'||${source}.id`;
  const at = options.view === "saved" ? "b.created_at" : "m.created_at";
  const predicate =
    options.view === "saved" ? savedMessageCardSql : personalMessageSql;
  const search =
    options.view === "sent"
      ? "instr(card_lower(m.content),card_lower(@q))>0"
      : "(instr(card_lower(m.content),card_lower(@q))>0 OR instr(card_lower(c.title),card_lower(@q))>0 OR instr(card_lower(l.label),card_lower(@q))>0)";
  return cardsStatement(
    `${projects}
    SELECT ${source}.id,${source}.owner_id,${source}.content,${source}.metadata,${source}.created_at,
      NULL updated_at,NULL title,NULL kind,NULL version,m.role,
      c.id conversation_id,c.title conversation_title,r.id run_id,${folder} folder_id,
      project.id project_id,project.name project_name,c.team_id,
      g.id agent_id,g.name agent_name,g.provider,
      ${`COALESCE((${personalMessageSql}),0) personal,
        (b.message_id IS NOT NULL OR EXISTS(SELECT 1 FROM artifacts sa WHERE sa.owner_id=m.owner_id
          AND sa.conversation_id=m.conversation_id AND sa.pinned=1 AND sa.archived=0
          AND json_extract(sa.metadata,'$.messageId')=m.id)) saved,0 feed_hidden`},
      ${at} order_at,${key} key,
      b.created_at saved_at,l.label
    FROM messages m
    JOIN conversations c ON c.id=${source}.conversation_id AND c.owner_id=${source}.owner_id
    LEFT JOIN runs r ON r.id=${source}.run_id AND r.owner_id=${source}.owner_id
    LEFT JOIN agents g ON g.id=(${agent}) AND g.owner_id=${source}.owner_id
    LEFT JOIN message_bookmarks b ON b.message_id=m.id AND b.owner_id=m.owner_id
    LEFT JOIN saved_labels l ON l.owner_id=${source}.owner_id AND l.item_key=${key}
    LEFT JOIN card_projects fp ON fp.folder_id IS ${folder}
    LEFT JOIN folders project ON project.id=fp.project_id AND project.owner_id=${source}.owner_id
    WHERE ${source}.owner_id=@owner AND (${source}.conversation_id IS NULL OR c.id IS NOT NULL)
      AND (${predicate})
      ${ids ? `AND ${source}.id IN (SELECT value FROM json_each(@ids))` : ""}
      AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS ${folder}))
      AND (@agent IS NULL OR (${filterAgent})=@agent)
      AND (@teams IS NULL OR c.team_id IN (SELECT value FROM json_each(@teams)))
      AND (@q IS NULL OR ${search})
      AND (@at IS NULL OR (${at},${key})<(@at,@key))
    ORDER BY ${at} DESC,${key} DESC LIMIT @limit`,
    db,
  )
    .all({
      owner,
      ids: ids ? JSON.stringify(ids) : null,
      folders: options.folders ? JSON.stringify(options.folders) : null,
      agent: options.agent || null,
      teams: options.teamIds.length ? JSON.stringify(options.teamIds) : null,
      q: options.q || null,
      at: before?.[0] ?? null,
      key: before?.[1] ?? null,
      limit,
    })
    .map((row) => parseRecord(cardRow, row, "messages"));
}
