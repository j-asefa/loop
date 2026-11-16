import type Database from "better-sqlite3";
import { z } from "zod";
import { readMessageMetadata } from "../../shared/message-metadata.js";
import { QueryRecords, ResultRecord } from "./rows.js";
import {
  maybeCanonicalResult,
  maybeRun,
  parseCanonicalResult,
  parseCanonicalResults,
  parseLooseArtifactAttachment,
  parseRecord,
} from "../row-schemas.js";
import { statement } from "./statement.js";

function parseSafeMessage(row: unknown) {
  const base = parseRecord(QueryRecords.messages, row, "messages");
  return {
    ...base,
    metadata: readMessageMetadata(base.metadata, "fallback"),
  };
}

function parseSafeMessages(rows: unknown[]) {
  return rows.map(parseSafeMessage);
}

const byIdStatement = statement(
  "SELECT * FROM results WHERE owner_id=? AND id=?",
);
export function byId(db: Database.Database, ownerId: string, id: string) {
  const row = byIdStatement(db).get(ownerId, id);
  return row === undefined
    ? undefined
    : parseRecord(ResultRecord, row, "results");
}

const sealedByIdStatement = statement(
  "SELECT * FROM results WHERE owner_id=? AND id=? AND sealed=1",
);
export function canonicalById(
  db: Database.Database,
  ownerId: string,
  id: string,
) {
  return maybeCanonicalResult(sealedByIdStatement(db).get(ownerId, id));
}

const listByConversationStatement = statement(
  "SELECT * FROM results WHERE owner_id=? AND conversation_id=? AND sealed=1 ORDER BY created_at ASC, id ASC",
);
export function listByConversation(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
) {
  return parseCanonicalResults(
    listByConversationStatement(db).all(ownerId, conversationId),
  );
}

const listBySourceResultStatement = statement(
  `SELECT res.* FROM result_context_edges edge
   JOIN results res ON res.owner_id=edge.owner_id AND res.id=edge.result_id
   WHERE edge.owner_id=? AND edge.source_result_id=? AND res.sealed=1
   ORDER BY edge.created_at DESC, edge.result_id ASC, edge.position ASC`,
);
export function listBySourceResult(
  db: Database.Database,
  ownerId: string,
  sourceResultId: string,
) {
  return parseCanonicalResults(
    listBySourceResultStatement(db).all(ownerId, sourceResultId),
  );
}

// The chain is chronological across kinds: the predecessor is the latest
// sealed result of any kind published before this one.
const precedingResultStatement = statement(
  `SELECT id FROM results
   WHERE owner_id=? AND conversation_id=? AND sealed=1
     AND id != ? AND created_at <= ?
   ORDER BY created_at DESC, rowid DESC
   LIMIT 1`,
);
const idOnlyRow = z.object({ id: z.string() });
export function precedingResult(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
  excludeResultId: string,
  createdAt: number,
) {
  const row = precedingResultStatement(db).get(
    ownerId,
    conversationId,
    excludeResultId,
    createdAt,
  );
  return row === undefined ? undefined : parseRecord(idOnlyRow, row, "results");
}

const sealedByMessageStatement = statement(
  "SELECT * FROM results WHERE owner_id=? AND message_id=? AND sealed=1 ORDER BY created_at ASC, rowid ASC LIMIT 1",
);
export function canonicalByMessage(
  db: Database.Database,
  ownerId: string,
  messageId: string,
) {
  return maybeCanonicalResult(
    sealedByMessageStatement(db).get(ownerId, messageId),
  );
}

const insertStatement = statement(
  `INSERT INTO results(
    id, owner_id, schema_version, kind, origin_completeness, sealed,
    created_at, conversation_id, run_id, message_id, agent_id,
    content_digest, stimulus, outcome, attachments, provenance, lineage
  ) VALUES (
    @id, @owner_id, @schema_version, @kind, @origin_completeness, @sealed,
    @created_at, @conversation_id, @run_id, @message_id, @agent_id,
    @content_digest, @stimulus, @outcome, @attachments, @provenance, @lineage
  )`,
);
export type InsertResultRow = z.infer<typeof ResultRecord>;
export function insert(db: Database.Database, row: InsertResultRow) {
  return insertStatement(db).run(row);
}

const sealDraftStatement = statement(
  `UPDATE results SET
    schema_version=@schema_version,
    kind=@kind,
    origin_completeness=@origin_completeness,
    sealed=@sealed,
    created_at=@created_at,
    conversation_id=@conversation_id,
    run_id=@run_id,
    message_id=@message_id,
    agent_id=@agent_id,
    content_digest=@content_digest,
    stimulus=@stimulus,
    outcome=@outcome,
    attachments=@attachments,
    provenance=@provenance,
    lineage=@lineage
   WHERE owner_id=@owner_id AND id=@id AND sealed=0`,
);
export function sealDraft(db: Database.Database, row: InsertResultRow) {
  return sealDraftStatement(db).run(row);
}

const markFeedCardDirtyStatement = statement(
  "INSERT OR IGNORE INTO feed_card_dirty(owner_id,conversation_id,card_key) VALUES(?,?,?)",
);
export function markFeedCardDirty(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
  cardKey = "*",
) {
  return markFeedCardDirtyStatement(db).run(ownerId, conversationId, cardKey);
}

const runRowStatement = statement(
  "SELECT * FROM runs WHERE owner_id=? AND id=?",
);
export function runRow(db: Database.Database, ownerId: string, runId: string) {
  return maybeRun(runRowStatement(db).get(ownerId, runId));
}

const conversationSummaryStatement = statement(
  "SELECT id, owner_id, agent_id, title, origin, execution_connection_id, project_id, team_id FROM conversations WHERE owner_id=? AND id=?",
);
const conversationSummaryRow = QueryRecords.conversations.pick({
  id: true,
  owner_id: true,
  agent_id: true,
  title: true,
  origin: true,
  execution_connection_id: true,
  project_id: true,
  team_id: true,
});
export function conversationSummary(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
) {
  const row = conversationSummaryStatement(db).get(ownerId, conversationId);
  return row === undefined
    ? undefined
    : parseRecord(conversationSummaryRow, row, "conversations");
}

const agentSummaryStatement = statement(
  "SELECT id, owner_id, name, provider, model, connection_id FROM agents WHERE owner_id=? AND id=?",
);
const agentSummaryRow = QueryRecords.agents.pick({
  id: true,
  owner_id: true,
  name: true,
  provider: true,
  model: true,
  connection_id: true,
});
export function agentSummary(
  db: Database.Database,
  ownerId: string,
  agentId: string,
) {
  const row = agentSummaryStatement(db).get(ownerId, agentId);
  return row === undefined
    ? undefined
    : parseRecord(agentSummaryRow, row, "agents");
}

const messageByIdStatement = statement(
  "SELECT * FROM messages WHERE owner_id=? AND id=?",
);
export function messageById(
  db: Database.Database,
  ownerId: string,
  messageId: string,
) {
  const row = messageByIdStatement(db).get(ownerId, messageId);
  return row === undefined ? undefined : parseSafeMessage(row);
}

const runAssistantMessagesStatement = statement(
  "SELECT * FROM messages WHERE owner_id=? AND conversation_id=? AND run_id=? AND role='assistant' ORDER BY created_at DESC, rowid DESC",
);
export function runAssistantMessages(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
  runId: string,
) {
  return parseSafeMessages(
    runAssistantMessagesStatement(db).all(ownerId, conversationId, runId),
  );
}

const runUserMessagesStatement = statement(
  "SELECT * FROM messages WHERE owner_id=? AND conversation_id=? AND run_id=? AND role='user' ORDER BY created_at DESC, rowid DESC",
);
export function runTriggerMessage(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
  runId: string,
) {
  return parseSafeMessages(
    runUserMessagesStatement(db).all(ownerId, conversationId, runId),
  ).find((m) => !m.metadata.steeringId);
}

const standaloneAssistantMessagesStatement = statement(
  "SELECT * FROM messages WHERE owner_id=? AND conversation_id=? AND run_id IS NULL AND role='assistant' ORDER BY created_at ASC, rowid ASC",
);
export function standaloneAssistantMessages(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
) {
  return parseSafeMessages(
    standaloneAssistantMessagesStatement(db).all(ownerId, conversationId),
  );
}

// Every standalone message of an imported conversation, so branch-aware
// readers can walk preserved parent pointers.
const standaloneMessagesStatement = statement(
  "SELECT * FROM messages WHERE owner_id=? AND conversation_id=? AND run_id IS NULL ORDER BY created_at ASC, rowid ASC",
);
export function standaloneMessages(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
) {
  return parseSafeMessages(
    standaloneMessagesStatement(db).all(ownerId, conversationId),
  );
}

const precedingStandaloneUserMessageStatement = statement(
  `SELECT u.* FROM messages m
   JOIN messages u ON u.owner_id=m.owner_id
     AND u.conversation_id=m.conversation_id
     AND u.run_id IS NULL
     AND u.role='user'
     AND (u.created_at<m.created_at OR (u.created_at=m.created_at AND u.rowid<m.rowid))
   WHERE m.owner_id=? AND m.conversation_id=? AND m.id=?
   ORDER BY u.created_at DESC, u.rowid DESC
   LIMIT 1`,
);
export function precedingStandaloneUserMessage(
  db: Database.Database,
  ownerId: string,
  conversationId: string,
  messageId: string,
) {
  const row = precedingStandaloneUserMessageStatement(db).get(
    ownerId,
    conversationId,
    messageId,
  );
  return row === undefined ? undefined : parseSafeMessage(row);
}

const steeringQuestionStatement = statement(
  `SELECT s.run_id AS run_id, q.id AS question_id, q.content AS question_content
   FROM run_steering s
   LEFT JOIN messages q ON q.id=s.message_id AND q.owner_id=s.owner_id
   WHERE s.owner_id=? AND s.id=?`,
);
const steeringQuestionRow = z.object({
  run_id: z.string(),
  question_id: z.string().nullable(),
  question_content: z.string().nullable(),
});
export function steeringQuestion(
  db: Database.Database,
  ownerId: string,
  steeringId: string,
) {
  const row = steeringQuestionStatement(db).get(ownerId, steeringId);
  return row === undefined
    ? undefined
    : parseRecord(steeringQuestionRow, row, "run_steering");
}

const artifactByIdStatement = statement(
  "SELECT id, owner_id, title, version, metadata FROM artifacts WHERE owner_id=? AND id=?",
);
export function artifactById(
  db: Database.Database,
  ownerId: string,
  artifactId: string,
) {
  const row = artifactByIdStatement(db).get(ownerId, artifactId);
  if (row === undefined) return undefined;
  return parseLooseArtifactAttachment(row);
}

const ownedObjectIdStatement = statement(
  "SELECT id FROM objects WHERE owner_id=? AND id=?",
);
const ownedObjectIdRow = QueryRecords.objects.pick({ id: true });
export function ownedObjectId(
  db: Database.Database,
  ownerId: string,
  objectId: string,
) {
  const row = ownedObjectIdStatement(db).get(ownerId, objectId);
  return row === undefined
    ? undefined
    : parseRecord(ownedObjectIdRow, row, "objects");
}

const publishedArtifactObjectStatement = statement(
  "SELECT checksum, mime, size FROM artifact_objects WHERE owner_id=? AND artifact_id=? LIMIT 1",
);
const publishedArtifactObjectRow = QueryRecords.artifact_objects.pick({
  checksum: true,
  mime: true,
  size: true,
});
export function publishedArtifactObject(
  db: Database.Database,
  ownerId: string,
  artifactId: string,
) {
  const row = publishedArtifactObjectStatement(db).get(ownerId, artifactId);
  return row === undefined
    ? undefined
    : parseRecord(publishedArtifactObjectRow, row, "artifact_objects");
}

export { parseCanonicalResult };

// Conversations holding standalone answers, each with the conversations
// its copied answers were copied from, in creation order.
const historicalAnswerConversationsStatement = statement(
  `SELECT c.owner_id,c.id conversation_id,
     json_group_array(DISTINCT s.conversation_id) FILTER (WHERE s.conversation_id IS NOT NULL AND s.conversation_id<>c.id) sources
   FROM conversations c
   JOIN messages m ON m.owner_id=c.owner_id AND m.conversation_id=c.id AND m.run_id IS NULL AND m.role='assistant'
   LEFT JOIN messages s ON s.owner_id=m.owner_id
     AND s.id=CASE WHEN json_valid(m.metadata) AND json_type(m.metadata,'$.sourceMessage')='text' THEN json_extract(m.metadata,'$.sourceMessage') END
   GROUP BY c.owner_id,c.id
   ORDER BY c.owner_id ASC,c.created_at ASC,c.rowid ASC`,
);
const historicalAnswerConversationRow = z.object({
  owner_id: z.string(),
  conversation_id: z.string(),
  sources: z.string().nullable(),
});
export function historicalAnswerConversations(db: Database.Database) {
  return historicalAnswerConversationsStatement(db)
    .all()
    .map((row) => {
      const parsed = parseRecord(
        historicalAnswerConversationRow,
        row,
        "conversations",
      );
      return {
        owner_id: parsed.owner_id,
        conversation_id: parsed.conversation_id,
        sources: z
          .array(z.string())
          .parse(parsed.sources ? JSON.parse(parsed.sources) : []),
      };
    });
}

// Rows inserted by the canonical-results SQL backfill await a digest. Their
// predecessor is the previous sealed result of any kind in the conversation.
const chainPendingBackfillStatement = statement(
  `WITH ordered AS (
     SELECT owner_id,id,
       LAG(id) OVER (PARTITION BY owner_id,conversation_id ORDER BY created_at ASC,rowid ASC) previous_id
     FROM results WHERE sealed=1
   )
   UPDATE results
   SET lineage=json_set(lineage,'$.parentResultId',(
     SELECT o.previous_id FROM ordered o WHERE o.owner_id=results.owner_id AND o.id=results.id
   ))
   WHERE origin_completeness='migrated_backfill' AND sealed=1
     AND content_digest='0000000000000000000000000000000000000000000000000000000000000000'`,
);
export function chainPendingBackfill(db: Database.Database) {
  return chainPendingBackfillStatement(db).run();
}

// Version 1 records predate sealed origins. These are the ones sealed for a
// copied message, whose author can be checked against the copy's source.
const unoriginatedCopiesStatement = statement(
  `SELECT res.* FROM results res
   JOIN messages m ON m.owner_id=res.owner_id AND m.id=res.message_id
   WHERE res.sealed=1 AND res.schema_version=1 AND res.kind='imported_answer'
     AND json_valid(m.metadata) AND json_type(m.metadata,'$.sourceMessage')='text'
   ORDER BY res.owner_id ASC,res.created_at ASC,res.rowid ASC`,
);
export function unoriginatedCopies(db: Database.Database) {
  return parseCanonicalResults(unoriginatedCopiesStatement(db).all());
}
